// -- ClaudeCode (2026-07-08): LifeSpace Connect OAuth 2.1 provider. Implements
// the MCP SDK's OAuthServerProvider — the SDK's mcpAuthRouter mounts the
// well-known metadata + /authorize + /token + /register(DCR) + /revoke routes on
// top of this. Connect is the authorization-server FACADE; Trust is the identity
// (SSO) and the SOLE JWT issuer (via the /v1/mint seam).
//
// Flow: /authorize → stash pending + set connect_txn cookie → redirect into
// Trust SSO → Trust returns ?sso_code to /oauth/trust/callback → we exchange it
// for the verified identity, issue our own auth code → /token mints a 1h Trust
// JWT + issues an opaque 30d refresh token.
import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { OAuthClientInformationFull, OAuthTokens, OAuthTokenRevocationRequest } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
// -- ClaudeCode (2026-07-09): typed OAuth errors so the SDK token handler emits
// the spec's 400 invalid_grant / 401 invalid_token instead of a generic 500.
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { sql, sha256, jsonb } from './db.js';
import { ssoStartUrl, exchangeSsoCode, mintAccessToken, trustPublicKey, type TrustIdentity } from './trust.js';
import { getSubtreeIds, renderConsent, renderMessage, tenantName, type TenantNode } from './tenants.js';
// ClaudeCode 2026-08-13 02:08 PM PDT — the picker's list is now built from ALL of
// the identity's role rows on the Connect app, not the single row Trust's SSO
// exchange happened to return. See memberships.ts for the bug this closes.
import {
  resolveMemberships, buildChoices, pickerNeeded, resolveGrantForChoice,
  type Membership, type Grant,
} from './memberships.js';
// ClaudeCode 2026-08-06 10:55 AM PDT — the authorize interstitial ("page before
// the page") + its cancelled landing.
import { renderInterstitial, renderCancelled, describeOrigin, clean, LABEL_MAX, HINT_MAX } from './interstitial.js';
// ClaudeCode 2026-08-06 05:33 PM PDT — in-flight OAuth transactions are now
// DURABLE (Postgres) instead of process-local Maps. See txn-store.ts for the
// outage this fixes.
import { txnStore } from './txn-store.js';

const ACCESS_TTL_SECONDS = 60 * 60; // 1h — bounds a revoked user's window (spec check #5)
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30d rolling
const AUTH_CODE_TTL_MS = 60 * 1000; // 60s single-use auth code
const PENDING_TTL_MS = 10 * 60 * 1000; // 10min to complete SSO
const REFRESH_PREFIX = 'lsc_';
const TXN_COOKIE = 'connect_txn';

interface PendingAuthorization {
  clientId: string;
  clientName?: string; // ClaudeCode 2026-08-06: shown on the interstitial + picker
  // ClaudeCode 2026-08-06 11:25 AM PDT — optional self-description supplied by the
  // caller on /authorize (?label=, ?tenant_hint=). UNVERIFIED and untrusted: shown
  // as "what this request says about itself", and the hint only ever PRESELECTS a
  // radio the person still has to confirm. It can never widen access.
  label?: string;
  tenantHint?: string;
  redirectUri: string; // the MCP client's redirect_uri
  state?: string;
  codeChallenge: string;
  resource?: string;
  expiresAt: number;
}

// ClaudeCode 2026-08-06 05:34 PM PDT — the authorize→SSO→callback correlation
// USED to be a seconds-long transient held in a process-local Map (mirroring
// Trust's own pendingStates). The authorize interstitial ended that: the window
// now spans the person reading a page plus a full Google sign-in, so a redeploy
// or restart inside it silently destroyed the request and the callback had no
// redirect_uri left to report the failure to. It lives in Postgres now — the
// cookie still carries the key, the row carries the request. See txn-store.ts.

// -- ClaudeCode (2026-07-09, G1 security fix): between SSO and the auth code, an
// admin picks a tenant. This holds the (verified, server-side) identity + the
// originating client request while the consent page is shown. Keyed by an opaque
// consentId carried in the form; identity is NEVER trusted from the client.
interface ConsentPending {
  clientId: string;
  clientName?: string;
  redirectUri: string;
  state?: string;
  codeChallenge: string;
  resource?: string;
  identity: TrustIdentity;
  homeTenant: string;
  // ClaudeCode 2026-08-13 02:10 PM PDT — the identity's full membership set and
  // the exact tenant ids offered on the page, captured SERVER-SIDE when the
  // picker was rendered. The POST is validated against this list, so a posted
  // tenant id can never widen the choice beyond what was actually offered.
  memberships?: Membership[];
  choiceIds?: string[];
  expiresAt: number;
}
// ClaudeCode 2026-08-06 05:34 PM PDT — consent state is durable too. An admin
// staring at the tenant picker across a redeploy used to lose the whole sign-in.

// ClaudeCode 2026-08-06 11:28 AM PDT — a tenant_hint may be a uuid or a name.
// If it is a uuid we can resolve, show the NAME (a uuid tells a person nothing);
// otherwise show exactly what was sent. Resolution is display-only — it grants
// nothing, and an unresolvable hint is not an error.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function displayHint(hint?: string): Promise<string | undefined> {
  if (!hint) return undefined;
  if (!UUID_RE.test(hint)) return hint;
  try {
    const name = await tenantName(hint);
    return name && name !== hint.slice(0, 8) ? name : hint;
  } catch {
    return hint;
  }
}

// Match a hint against the tenants this person can actually choose. Exact uuid,
// else case-insensitive name match. No match = no preselection, nothing else.
function resolveHintToTenant(hint: string | undefined, tree: TenantNode[]): string | undefined {
  if (!hint) return undefined;
  const h = hint.trim().toLowerCase();
  const byId = tree.find((t) => t.id.toLowerCase() === h);
  if (byId) return byId.id;
  return tree.find((t) => t.name.trim().toLowerCase() === h)?.id;
}

function connectBaseUrl(): string {
  return process.env.CONNECT_BASE_URL ?? 'https://connect.lifespace.com';
}

function trustCallbackUri(): string {
  return `${connectBaseUrl()}/oauth/trust/callback`;
}

// ---------------------------------------------------------------------------
// Clients store (Dynamic Client Registration)
// ---------------------------------------------------------------------------
// -- ClaudeCode: Clients are tenant-LESS (spec D9) — registration precedes any
// user identity. The secret is stored HASHED. Claude/Cowork connectors register
// as public clients (token_endpoint_auth_method 'none') + PKCE, which the SDK
// enforces on every token exchange, so we treat all clients as public-effective
// at the token endpoint (we never return a plaintext secret to compare).
class ConnectClientsStore implements OAuthRegisteredClientsStore {
  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const rows = await sql`SELECT * FROM ls_connect_clients WHERE client_id = ${clientId}`;
    const r = rows[0];
    if (!r) return undefined;
    return {
      client_id: r.client_id,
      client_id_issued_at: r.client_id_issued_at ?? undefined,
      // Public-effective: no plaintext secret is ever surfaced (hash at rest).
      redirect_uris: r.redirect_uris ?? [],
      grant_types: r.grant_types ?? [],
      response_types: r.response_types ?? [],
      token_endpoint_auth_method: r.token_endpoint_auth_method ?? 'none',
      client_name: r.client_name ?? undefined,
      scope: r.scope ?? undefined,
    } as OAuthClientInformationFull;
  }

  async registerClient(client: OAuthClientInformationFull): Promise<OAuthClientInformationFull> {
    const secretHash = client.client_secret ? sha256(client.client_secret) : null;
    await sql`
      INSERT INTO ls_connect_clients (
        client_id, client_name, redirect_uris, grant_types, response_types,
        token_endpoint_auth_method, scope, secret_hash,
        client_id_issued_at, client_secret_expires_at, metadata
      ) VALUES (
        ${client.client_id},
        ${client.client_name ?? null},
        ${jsonb(client.redirect_uris ?? [])},
        ${jsonb(client.grant_types ?? [])},
        ${jsonb(client.response_types ?? [])},
        ${client.token_endpoint_auth_method ?? 'none'},
        ${client.scope ?? null},
        ${secretHash},
        ${client.client_id_issued_at ?? null},
        ${client.client_secret_expires_at ?? null},
        ${jsonb(client as unknown as Record<string, unknown>)}
      )
      ON CONFLICT (client_id) DO NOTHING
    `;
    return client;
  }
}

export class ConnectOAuthProvider implements OAuthServerProvider {
  readonly clientsStore = new ConnectClientsStore();

  // Step 1 — the MCP client hit /authorize. Stash the request, drop a cookie, and
  // RENDER THE INTERSTITIAL. ClaudeCode 2026-08-06 10:56 AM PDT: this used to 302
  // straight into Google, which lands a context-free account chooser in whatever
  // Chrome profile happened to be frontmost — no statement of which tool asked or
  // which tenant is involved. Now nothing leaves this origin until the person
  // clicks Continue. The OAuth parameters never travel through the page: they stay
  // in the server-side `pending` entry keyed by the HttpOnly connect_txn cookie,
  // so Continue cannot drop or mangle them.
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    // The SDK ignores unknown query params, so read the caller's optional
    // self-description straight off the request and sanitize it here, once.
    const q = ((res.req as Request | undefined)?.query ?? {}) as Record<string, unknown>;
    const label = clean(typeof q.label === 'string' ? q.label : undefined, LABEL_MAX);
    const tenantHint = clean(typeof q.tenant_hint === 'string' ? q.tenant_hint : undefined, HINT_MAX);
    const txn = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + PENDING_TTL_MS;
    // ClaudeCode 2026-08-06 05:36 PM PDT — persisted, not held in memory: this
    // row has to outlive a redeploy that lands while the person is at Google.
    await txnStore().put(txn, 'auth', {
      clientId: client.client_id,
      clientName: client.client_name,
      label,
      tenantHint,
      redirectUri: params.redirectUri,
      state: params.state,
      codeChallenge: params.codeChallenge,
      resource: params.resource?.href,
      expiresAt,
    } satisfies PendingAuthorization, expiresAt);
    res.cookie(TXN_COOKIE, txn, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax', // all hops are top-level GET navigations → Lax sends it
      path: '/oauth',
      maxAge: PENDING_TTL_MS,
    });
    // The copy-to-clipboard link is THIS authorize request, verbatim — pasting it
    // into another Chrome profile replays the same OAuth request there (fresh txn,
    // fresh cookie), which is exactly the "start in the right profile" escape.
    const originalUrl = (res.req as Request | undefined)?.originalUrl ?? '/authorize';
    res.type('html').send(
      renderInterstitial({
        clientName: client.client_name ?? '',
        continueUrl: '/oauth/continue',
        cancelUrl: '/oauth/cancel',
        authorizeUrl: new URL(originalUrl, connectBaseUrl()).href,
        origin: describeOrigin(params.redirectUri),
        label,
        tenantHint: await displayHint(tenantHint),
      }),
    );
  }

  // Step 1b — Continue clicked. The cookie identifies the held request; we simply
  // hand the browser to Trust's Google SSO, same as the old direct redirect.
  async handleContinue(req: Request, res: Response): Promise<void> {
    const txn = parseCookie(req.headers.cookie, TXN_COOKIE);
    // peek, not take — Continue must survive a back-button revisit.
    const pend = txn ? ((await txnStore().peek(txn, 'auth')) as PendingAuthorization | undefined) : undefined;
    if (!pend) {
      res.status(400).type('html').send(renderMessage('Sign-in session expired', 'This sign-in window closed before it was used. Start the connection again from the tool that asked.'));
      return;
    }
    res.redirect(302, ssoStartUrl(trustCallbackUri()));
  }

  // Step 1c — Cancel clicked (from the interstitial or the tenant picker). Drop
  // everything we were holding and land on a terminal page. Deliberately NOT a
  // redirect back to the client: a refusal must not bounce into a new authorize.
  async handleCancel(req: Request, res: Response): Promise<void> {
    const txn = parseCookie(req.headers.cookie, TXN_COOKIE);
    if (txn) await txnStore().drop(txn);
    res.clearCookie(TXN_COOKIE, { path: '/oauth' });
    res.status(200).type('html').send(renderCancelled());
  }

  // Step 2 — Trust bounced back to /oauth/trust/callback?sso_code=… . This is a
  // plain Express handler (not part of the SDK provider surface). It closes the
  // loop: verify the SSO, issue OUR auth code, redirect to the MCP client.
  async handleTrustCallback(req: Request, res: Response): Promise<void> {
    const ssoError = typeof req.query.sso_error === 'string' ? req.query.sso_error : undefined;
    const ssoCode = typeof req.query.sso_code === 'string' ? req.query.sso_code : undefined;

    const txn = parseCookie(req.headers.cookie, TXN_COOKIE);
    // Single-use: the DELETE ... RETURNING consumes it atomically, so two
    // instances (or a double-fired callback) can never both claim it.
    const pend = txn ? ((await txnStore().take(txn, 'auth')) as PendingAuthorization | undefined) : undefined;
    res.clearCookie(TXN_COOKIE, { path: '/oauth' });

    if (!pend) {
      logCallbackFailure('held_authorize_request_not_found');
      res.status(400).type('html').send(renderMessage(
        'Sign-in session expired',
        'This sign-in took too long or was already completed. Start the connection again from the tool that asked.',
      ));
      return;
    }

    // ClaudeCode 2026-08-06 07:14 PM PDT — Trust refused the IDENTITY (no role
    // assignment for this address on the Connect app, or a domain block). This is
    // NOT something the calling tool can retry its way out of — a person has to be
    // granted access — so it gets a terminal page here, the same doctrine the
    // Cancel landing already follows ("a refusal must not bounce into a new
    // authorize"). Bouncing it back as a bare OAuth error was actively harmful:
    // mcp-remote drops error_description and renders the refusal as the useless
    // "Error: No authorization code received", which is what sent us hunting for a
    // code bug when the real answer was a missing grant.
    if (ssoError) {
      logCallbackFailure('identity_refused_by_trust', ssoError);
      res.status(403).type('html').send(renderMessage(
        'This account does not have access',
        `${ssoError}. LifeSpace Connect refused the Google account you just signed in with. ` +
        'Either sign in again with an address that has been granted access to LifeSpace Connect, ' +
        'or ask an administrator to grant that address access. Nothing was connected.',
      ));
      return;
    }
    // The two below are technical/transient and the client CAN usefully retry, so
    // they keep the spec-shaped error redirect. Both are now logged — this whole
    // path used to fail in total silence, with nothing in Railway to look at.
    if (!ssoCode) {
      logCallbackFailure('no_sso_code_returned');
      res.redirect(302, errorRedirect(pend.redirectUri, 'access_denied', 'No sign-in code returned', pend.state));
      return;
    }

    let identity: TrustIdentity;
    try {
      identity = await exchangeSsoCode(ssoCode);
    } catch (err) {
      logCallbackFailure('sso_code_exchange_failed', err instanceof Error ? err.message : 'unknown');
      res.redirect(302, errorRedirect(pend.redirectUri, 'access_denied', 'Sign-in verification failed', pend.state));
      return;
    }

    // -- ClaudeCode (2026-07-09, G1 security fix): tenant consent — the auth code
    // is issued only after the person chooses, so the token is scoped to the
    // CHOSEN tenant instead of silently minting at the role's home.
    //
    // ClaudeCode 2026-08-13 02:14 PM PDT — the gate is now MEMBERSHIP COUNT, not
    // role. It used to be `if (!isAdmin) → skip the picker`, on the assumption
    // that a role=user has exactly one tenant. That assumption is false: an
    // identity can hold several role rows on the app (jon@coachsimple.net holds
    // user@Coach Simple AND user@Curriculum Rebuild), and the old gate handed
    // those people whichever row Trust's SSO exchange happened to return — no
    // page, no choice, no way to tell it had happened. Now the choice list is the
    // union of every membership (plus descendants of the admin ones), and ANY
    // identity with ≥2 tenants to choose between gets the picker.
    const homeTenant = identity.tenant_id || '';
    const memberships = await resolveMemberships(identity.email);
    const tree = await buildChoices(memberships);

    if (!pickerNeeded(tree)) {
      // Nothing to choose. Keep the single tenant we know about — the membership
      // row if there is one, else the tenant Trust returned.
      const only = tree[0]?.id || homeTenant;
      await this.issueCodeAndRedirect(res, pend, identity,
        resolveGrantForChoice(memberships, only, identity));
      return;
    }

    const consentId = crypto.randomBytes(32).toString('hex');
    const consentExpiresAt = Date.now() + PENDING_TTL_MS;
    await txnStore().put(consentId, 'consent', {
      clientId: pend.clientId,
      clientName: pend.clientName,
      redirectUri: pend.redirectUri,
      state: pend.state,
      codeChallenge: pend.codeChallenge,
      resource: pend.resource,
      identity,
      homeTenant,
      memberships,
      choiceIds: tree.map((t) => t.id),
      expiresAt: consentExpiresAt,
    } satisfies ConsentPending, consentExpiresAt);
    // A tenant_hint that matches one of the tenants this person can choose
    // PRESELECTS that radio — it is still a confirmation, never an auto-submit.
    const preselect = resolveHintToTenant(pend.tenantHint, tree) ?? homeTenant;
    res.type('html').send(renderConsent(consentId, identity.email, preselect, tree, pend.clientName, pend.label, pend.tenantHint));
  }

  // Step 2b — the admin submitted the tenant picker. Validate the chosen tenant
  // is inside their subtree, then issue the auth code scoped to it.
  async handleConsent(req: Request, res: Response): Promise<void> {
    const body = (req.body ?? {}) as Record<string, string>;
    const consentId = typeof body.consent === 'string' ? body.consent : '';
    const chosen = typeof body.tenant_id === 'string' ? body.tenant_id.trim() : '';
    const cp = consentId ? ((await txnStore().take(consentId, 'consent')) as ConsentPending | undefined) : undefined;
    if (!cp) {
      res.status(400).type('html').send(renderMessage('Session expired', 'Your sign-in window closed. Please retry the connection.'));
      return;
    }

    // The chosen tenant must be one the page actually OFFERED. Never trust an
    // arbitrary posted tenant id.
    // ClaudeCode 2026-08-13 02:20 PM PDT — the check is against `choiceIds`, the
    // server-side list captured when the picker was rendered. It used to be
    // `getSubtreeIds(homeTenant)`, which was both too narrow (it rejected a
    // sibling membership the person legitimately holds) and tied to the one
    // tenant Trust's SSO exchange returned. Older consent rows written before
    // this deploy carry no choiceIds — those still fall back to the subtree test.
    const memberships = cp.memberships ?? [];
    let chosenTenant = cp.homeTenant;
    if (chosen && chosen !== cp.homeTenant) {
      const allowed = cp.choiceIds ? new Set(cp.choiceIds) : await getSubtreeIds(cp.homeTenant);
      if (!allowed.has(chosen)) {
        res.status(403).type('html').send(renderMessage('Not allowed', 'You can only connect to a tenant you were offered.'));
        return;
      }
      chosenTenant = chosen;
    }

    const pend: PendingAuthorization = {
      clientId: cp.clientId,
      redirectUri: cp.redirectUri,
      state: cp.state,
      codeChallenge: cp.codeChallenge,
      resource: cp.resource,
      expiresAt: Date.now() + AUTH_CODE_TTL_MS,
    };
    await this.issueCodeAndRedirect(res, pend, cp.identity,
      resolveGrantForChoice(memberships, chosenTenant, cp.identity));
  }

  // Issue a single-use auth code carrying the verified identity + the CHOSEN
  // tenant, then 302 back to the MCP client.
  // ClaudeCode 2026-08-13 02:24 PM PDT — takes the whole GRANT now, not just a
  // tenant id. The row used to record `identity.role` / `identity.modules` — the
  // role and modules of whichever membership Trust's SSO exchange returned —
  // even when the person had chosen a DIFFERENT tenant, so a two-membership
  // identity got the other row's modules stamped on its session.
  private async issueCodeAndRedirect(
    res: Response,
    pend: PendingAuthorization,
    identity: TrustIdentity,
    grant: Grant,
  ): Promise<void> {
    const code = crypto.randomBytes(32).toString('hex');
    await sql`
      INSERT INTO ls_connect_codes (
        code_hash, client_id, tenant_id, user_id, user_email, role, modules,
        pkce_challenge, redirect_uri, client_state, resource, expires_at
      ) VALUES (
        ${sha256(code)}, ${pend.clientId}, ${grant.tenantId || null}, ${identity.email},
        ${identity.email}, ${grant.role}, ${jsonb(grant.modules ?? [])},
        ${pend.codeChallenge}, ${pend.redirectUri}, ${pend.state ?? null}, ${pend.resource ?? null},
        ${new Date(Date.now() + AUTH_CODE_TTL_MS)}
      )
    `;
    const url = new URL(pend.redirectUri);
    url.searchParams.set('code', code);
    if (pend.state) url.searchParams.set('state', pend.state);
    res.redirect(302, url.href);
  }

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const rows = await sql`SELECT pkce_challenge FROM ls_connect_codes WHERE code_hash = ${sha256(authorizationCode)}`;
    const r = rows[0];
    if (!r) throw new InvalidGrantError('unknown authorization code');
    return r.pkce_challenge as string;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<OAuthTokens> {
    const codeHash = sha256(authorizationCode);
    const rows = await sql`SELECT * FROM ls_connect_codes WHERE code_hash = ${codeHash}`;
    const r = rows[0];
    if (!r) throw new InvalidGrantError('unknown authorization code');
    if (r.client_id !== client.client_id) throw new InvalidGrantError('client mismatch');
    if (r.used) throw new InvalidGrantError('authorization code already used');
    if (new Date(r.expires_at).getTime() < Date.now()) throw new InvalidGrantError('authorization code expired');

    // Single-use: burn it now.
    await sql`UPDATE ls_connect_codes SET used = true WHERE code_hash = ${codeHash}`;

    // The code row's tenant_id is the tenant the user picked at consent — mint
    // scoped to it (Trust down-scopes if it's a descendant of their home).
    const minted = await mintForChosenTenant(r.user_email as string, r.tenant_id as string);
    const refresh = await this.issueRefreshToken(client.client_id, {
      userId: r.user_id as string,
      email: r.user_email as string,
      tenantId: minted.tenant_id || (r.tenant_id as string),
      role: minted.role,
      modules: minted.modules,
    });

    return {
      access_token: minted.token,
      token_type: 'bearer',
      expires_in: minted.expires_in,
      refresh_token: refresh,
      scope: minted.modules.join(' ') || undefined,
    };
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
  ): Promise<OAuthTokens> {
    const tokenHash = sha256(refreshToken);
    const rows = await sql`SELECT * FROM ls_connect_tokens WHERE token_hash = ${tokenHash}`;
    const r = rows[0];
    if (!r) throw new InvalidGrantError('unknown refresh token');
    if (r.client_id !== client.client_id) throw new InvalidGrantError('client mismatch');
    if (r.revoked_at) throw new InvalidGrantError('refresh token revoked');
    if (new Date(r.expires_at).getTime() < Date.now()) throw new InvalidGrantError('refresh token expired');

    // Re-mint from Trust — role/modules are re-resolved, so a revoked user hits
    // a 403 here and the session dies (spec acceptance check #5). Re-mint for the
    // SAME chosen tenant stored on the refresh row — never silently re-widen to
    // the user's home tenant (order G1 security fix).
    const minted = await mintForChosenTenant(r.user_email as string, r.tenant_id as string);

    // Rotate the refresh token (30d rolling): burn the old, issue a new one.
    await sql`UPDATE ls_connect_tokens SET revoked_at = now() WHERE token_hash = ${tokenHash}`;
    const refresh = await this.issueRefreshToken(client.client_id, {
      userId: r.user_id as string,
      email: r.user_email as string,
      tenantId: minted.tenant_id || (r.tenant_id as string),
      role: minted.role,
      modules: minted.modules,
    });

    return {
      access_token: minted.token,
      token_type: 'bearer',
      expires_in: minted.expires_in,
      refresh_token: refresh,
      scope: minted.modules.join(' ') || undefined,
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    let claims: Record<string, unknown>;
    try {
      claims = jwt.verify(token, trustPublicKey(), { algorithms: ['RS256'] }) as Record<string, unknown>;
    } catch {
      throw new InvalidTokenError('invalid or expired access token');
    }
    return {
      token,
      clientId: (claims.app_id as string) ?? 'lifespace-connect',
      scopes: Array.isArray(claims.modules) ? (claims.modules as string[]) : [],
      expiresAt: typeof claims.exp === 'number' ? claims.exp : undefined,
      extra: { claims },
    };
  }

  async revokeToken(
    _client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    // Best-effort: only opaque refresh tokens live in our store; access tokens
    // are stateless Trust JWTs bounded by their 1h expiry.
    await sql`UPDATE ls_connect_tokens SET revoked_at = now() WHERE token_hash = ${sha256(request.token)} AND revoked_at IS NULL`;
  }

  private async issueRefreshToken(
    clientId: string,
    who: { userId: string; email: string; tenantId: string; role: string; modules: string[] },
  ): Promise<string> {
    const raw = REFRESH_PREFIX + crypto.randomBytes(32).toString('hex');
    await sql`
      INSERT INTO ls_connect_tokens (
        token_hash, client_id, tenant_id, user_id, user_email, role, modules,
        expires_at, last_used_at
      ) VALUES (
        ${sha256(raw)}, ${clientId}, ${who.tenantId || null}, ${who.userId}, ${who.email},
        ${who.role}, ${jsonb(who.modules)}, ${new Date(Date.now() + REFRESH_TTL_MS)}, now()
      )
    `;
    return raw;
  }
}

// ClaudeCode 2026-08-06 07:16 PM PDT — every failure on the Trust return leg used
// to be swallowed silently, so a real outage left NOTHING in Railway to read and
// the only evidence was whatever the MCP client happened to print. One line per
// failure, reason-coded. Never logs the sso_code, the txn, or any token — only
// the branch that fired and a short human reason.
// ClaudeCode 2026-08-13 02:30 PM PDT — mint for the tenant the person CHOSE, and
// make a refusal legible.
//
// KNOWN UPSTREAM GAP (not fixable inside this repo — Trust owns it): Trust's
// /v1/mint resolves the caller's role row with an UNORDERED single-row select
// (Trust mint.ts resolveRole — `const [exact] = await db.select()…` with no
// ORDER BY / LIMIT, unlike auth.ts which orders by role rank then row id). For an
// identity holding SEVERAL rows on the app, which row that returns is Postgres
// heap order — it is why jon@coachsimple.net minted Coach Simple at 20:45 and
// Curriculum Rebuild at 20:50 from identical sign-ins. When the row it picks is
// not the tenant the person chose, mint takes its cross-tenant branch and refuses
// a role=user with "Only admins may scope a connection to another tenant". Until
// Trust's resolveRole is chosen-tenant-aware, that refusal is reported honestly
// here as an OAuth invalid_grant with the reason on it, instead of surfacing as
// an opaque 500 from the token endpoint.
async function mintForChosenTenant(email: string, chosenTenant: string) {
  try {
    return await mintAccessToken(email, ACCESS_TTL_SECONDS, chosenTenant);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'mint failed';
    logCallbackFailure('mint_refused_for_chosen_tenant', msg);
    throw new InvalidGrantError(`Could not issue a token for the selected tenant: ${msg}`);
  }
}

function logCallbackFailure(reason: string, detail?: string): void {
  console.error(`[connect] trust-callback failed: ${reason}${detail ? ` — ${detail}` : ''}`);
}

// ---------------------------------------------------------------------------
function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return undefined;
}

function errorRedirect(redirectUri: string, error: string, description: string, state?: string): string {
  const u = new URL(redirectUri);
  u.searchParams.set('error', error);
  u.searchParams.set('error_description', description);
  if (state) u.searchParams.set('state', state);
  return u.href;
}
