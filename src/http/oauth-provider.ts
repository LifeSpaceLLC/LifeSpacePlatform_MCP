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
import { getSubtreeTree, getSubtreeIds, renderConsent, renderMessage } from './tenants.js';
// ClaudeCode 2026-08-06 10:55 AM PDT — the authorize interstitial ("page before
// the page") + its cancelled landing.
import { renderInterstitial, renderCancelled } from './interstitial.js';

const ACCESS_TTL_SECONDS = 60 * 60; // 1h — bounds a revoked user's window (spec check #5)
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30d rolling
const AUTH_CODE_TTL_MS = 60 * 1000; // 60s single-use auth code
const PENDING_TTL_MS = 10 * 60 * 1000; // 10min to complete SSO
const REFRESH_PREFIX = 'lsc_';
const TXN_COOKIE = 'connect_txn';

interface PendingAuthorization {
  clientId: string;
  clientName?: string; // ClaudeCode 2026-08-06: shown on the interstitial + picker
  redirectUri: string; // the MCP client's redirect_uri
  state?: string;
  codeChallenge: string;
  resource?: string;
  expiresAt: number;
}

// -- ClaudeCode: The authorize→SSO→callback correlation is a seconds-long
// transient. Trust itself keeps its equivalent (pendingStates/pendingCodes) in
// memory; we mirror that. Railway is single-instance today (D3); the cookie
// carries the key, this map carries the request. Swept lazily on access.
const pending = new Map<string, PendingAuthorization>();

function sweepPending(): void {
  const now = Date.now();
  for (const [k, v] of pending) if (v.expiresAt < now) pending.delete(k);
}

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
  expiresAt: number;
}
const consentPending = new Map<string, ConsentPending>();
function sweepConsent(): void {
  const now = Date.now();
  for (const [k, v] of consentPending) if (v.expiresAt < now) consentPending.delete(k);
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
    sweepPending();
    const txn = crypto.randomBytes(32).toString('hex');
    pending.set(txn, {
      clientId: client.client_id,
      clientName: client.client_name,
      redirectUri: params.redirectUri,
      state: params.state,
      codeChallenge: params.codeChallenge,
      resource: params.resource?.href,
      expiresAt: Date.now() + PENDING_TTL_MS,
    });
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
      }),
    );
  }

  // Step 1b — Continue clicked. The cookie identifies the held request; we simply
  // hand the browser to Trust's Google SSO, same as the old direct redirect.
  async handleContinue(req: Request, res: Response): Promise<void> {
    sweepPending();
    const txn = parseCookie(req.headers.cookie, TXN_COOKIE);
    const pend = txn ? pending.get(txn) : undefined;
    if (!pend || pend.expiresAt < Date.now()) {
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
    if (txn) pending.delete(txn);
    res.clearCookie(TXN_COOKIE, { path: '/oauth' });
    sweepConsent();
    res.status(200).type('html').send(renderCancelled());
  }

  // Step 2 — Trust bounced back to /oauth/trust/callback?sso_code=… . This is a
  // plain Express handler (not part of the SDK provider surface). It closes the
  // loop: verify the SSO, issue OUR auth code, redirect to the MCP client.
  async handleTrustCallback(req: Request, res: Response): Promise<void> {
    const ssoError = typeof req.query.sso_error === 'string' ? req.query.sso_error : undefined;
    const ssoCode = typeof req.query.sso_code === 'string' ? req.query.sso_code : undefined;

    const txn = parseCookie(req.headers.cookie, TXN_COOKIE);
    const pend = txn ? pending.get(txn) : undefined;
    if (txn) pending.delete(txn);
    res.clearCookie(TXN_COOKIE, { path: '/oauth' });

    if (!pend || pend.expiresAt < Date.now()) {
      res.status(400).send('Sign-in session expired or not found. Please retry the connection.');
      return;
    }

    // Trust rejected the login (no role assignment / domain block).
    if (ssoError) {
      res.redirect(302, errorRedirect(pend.redirectUri, 'access_denied', ssoError, pend.state));
      return;
    }
    if (!ssoCode) {
      res.redirect(302, errorRedirect(pend.redirectUri, 'access_denied', 'No sign-in code returned', pend.state));
      return;
    }

    let identity: TrustIdentity;
    try {
      identity = await exchangeSsoCode(ssoCode);
    } catch {
      res.redirect(302, errorRedirect(pend.redirectUri, 'access_denied', 'Sign-in verification failed', pend.state));
      return;
    }

    // -- ClaudeCode (2026-07-09, G1 security fix): tenant consent. A plain
    // role=user is PINNED to their own tenant (no picker) — issue the code
    // straight away. An admin gets the subtree picker; the auth code is issued
    // only after they choose (handleConsent), so the token is scoped to the
    // CHOSEN tenant instead of silently minting at the role's home (root).
    const homeTenant = identity.tenant_id || '';
    const isAdmin = identity.role === 'admin' || identity.role === 'super_admin';
    if (!isAdmin) {
      await this.issueCodeAndRedirect(res, pend, identity, homeTenant);
      return;
    }

    // ClaudeCode 2026-08-06 10:58 AM PDT — single-membership identities skip the
    // picker: an admin whose subtree is just their own tenant has nothing to
    // choose, so don't make them click through a one-option page.
    const tree = await getSubtreeTree(homeTenant);
    if (tree.length <= 1) {
      await this.issueCodeAndRedirect(res, pend, identity, homeTenant);
      return;
    }

    sweepConsent();
    const consentId = crypto.randomBytes(32).toString('hex');
    consentPending.set(consentId, {
      clientId: pend.clientId,
      clientName: pend.clientName,
      redirectUri: pend.redirectUri,
      state: pend.state,
      codeChallenge: pend.codeChallenge,
      resource: pend.resource,
      identity,
      homeTenant,
      expiresAt: Date.now() + PENDING_TTL_MS,
    });
    res.type('html').send(renderConsent(consentId, identity.email, homeTenant, tree, pend.clientName));
  }

  // Step 2b — the admin submitted the tenant picker. Validate the chosen tenant
  // is inside their subtree, then issue the auth code scoped to it.
  async handleConsent(req: Request, res: Response): Promise<void> {
    sweepConsent();
    const body = (req.body ?? {}) as Record<string, string>;
    const consentId = typeof body.consent === 'string' ? body.consent : '';
    const chosen = typeof body.tenant_id === 'string' ? body.tenant_id.trim() : '';
    const cp = consentId ? consentPending.get(consentId) : undefined;
    if (cp) consentPending.delete(consentId);
    if (!cp || cp.expiresAt < Date.now()) {
      res.status(400).type('html').send(renderMessage('Session expired', 'Your sign-in window closed. Please retry the connection.'));
      return;
    }

    // The chosen tenant must be the home tenant or a descendant of it (belt —
    // Trust re-validates at mint). Never trust an arbitrary posted tenant id.
    let chosenTenant = cp.homeTenant;
    if (chosen && chosen !== cp.homeTenant) {
      const subtree = await getSubtreeIds(cp.homeTenant);
      if (!subtree.has(chosen)) {
        res.status(403).type('html').send(renderMessage('Not allowed', 'You can only connect to a tenant inside your own subtree.'));
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
    await this.issueCodeAndRedirect(res, pend, cp.identity, chosenTenant);
  }

  // Issue a single-use auth code carrying the verified identity + the CHOSEN
  // tenant, then 302 back to the MCP client. tenant_id here is the tenant the
  // token will be scoped to (home for users, picked for admins).
  private async issueCodeAndRedirect(
    res: Response,
    pend: PendingAuthorization,
    identity: TrustIdentity,
    chosenTenant: string,
  ): Promise<void> {
    const code = crypto.randomBytes(32).toString('hex');
    await sql`
      INSERT INTO ls_connect_codes (
        code_hash, client_id, tenant_id, user_id, user_email, role, modules,
        pkce_challenge, redirect_uri, client_state, resource, expires_at
      ) VALUES (
        ${sha256(code)}, ${pend.clientId}, ${chosenTenant || null}, ${identity.email},
        ${identity.email}, ${identity.role}, ${jsonb(identity.modules ?? [])},
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
    const minted = await mintAccessToken(r.user_email as string, ACCESS_TTL_SECONDS, r.tenant_id as string);
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
    const minted = await mintAccessToken(r.user_email as string, ACCESS_TTL_SECONDS, r.tenant_id as string);

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
