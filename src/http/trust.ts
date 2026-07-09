// -- ClaudeCode (2026-07-08): Trust client for LifeSpace Connect. Connect never
// signs JWTs — Trust stays the SOLE issuer. Connect (1) redirects the browser
// into Trust's Google SSO, (2) exchanges the returned one-time sso_code for the
// verified identity, (3) mints short-TTL access tokens via the /v1/mint seam,
// and (4) verifies access tokens locally with Trust's public key.
const TRUST_BASE = process.env.TRUST_BASE_URL ?? 'https://trust.lifespace.com';

function appId(): string {
  const id = process.env.CONNECT_TRUST_APP_ID;
  if (!id) throw new Error('CONNECT_TRUST_APP_ID not set (the lifespace-connect Trust app id)');
  return id;
}

function mintKey(): string {
  const k = process.env.TRUST_MINT_API_KEY;
  if (!k) throw new Error('TRUST_MINT_API_KEY not set');
  return k;
}

/** RS256 public key used to verify Trust-minted access tokens locally. */
export function trustPublicKey(): string {
  const key = process.env.TRUST_JWT_PUBLIC_KEY;
  if (!key) throw new Error('TRUST_JWT_PUBLIC_KEY not set');
  return key.replace(/\\n/g, '\n');
}

/** Build the Trust SSO start URL. `callbackUri` must be registered in the
 *  lifespace-connect app's allowed_redirect_uris (exact match). */
export function ssoStartUrl(callbackUri: string, provider = 'google'): string {
  const u = new URL(`${TRUST_BASE}/auth/${provider}`);
  u.searchParams.set('app_id', appId());
  u.searchParams.set('redirect_uri', callbackUri);
  return u.toString();
}

export interface TrustIdentity {
  email: string;
  name?: string | null;
  role: string;
  tenant_id: string;
  modules?: string[] | null;
}

/** Exchange the one-time sso_code from Trust's callback for the verified
 *  identity. Proves the login is real and yields email/tenant/role/modules. */
export async function exchangeSsoCode(code: string): Promise<TrustIdentity> {
  const res = await fetch(`${TRUST_BASE}/auth/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Trust /auth/exchange failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as { user: TrustIdentity };
  if (!data.user?.email) throw new Error('Trust /auth/exchange returned no user identity');
  return data.user;
}

export interface MintedToken {
  token: string;
  expires_in: number;
  tenant_id: string;
  role: string;
  modules: string[];
}

/** Mint a short-TTL Trust access token for an SSO'd user. Trust RE-RESOLVES the
 *  user's role + modules for the connect app on every call — so revoking the
 *  user in Trust kills the session on the next mint (a 403 here). `chosenTenantId`
 *  is the tenant the user picked in the consent screen (order G1 security fix):
 *  if it differs from their home tenant, Trust validates admin+subtree and
 *  down-scopes to least-privilege at that tenant. Omit/home = home scope. */
export async function mintAccessToken(email: string, ttlSeconds: number, chosenTenantId?: string): Promise<MintedToken> {
  const res = await fetch(`${TRUST_BASE}/v1/mint`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${mintKey()}`,
    },
    body: JSON.stringify({ app_id: appId(), email, ttl_seconds: ttlSeconds, chosen_tenant_id: chosenTenantId }),
  });
  if (res.status === 403) {
    throw new Error('access_denied: no role assignment for this user on the Connect app');
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Trust /v1/mint failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as {
    token: string;
    expires_in: number;
    tenant_id: string;
    role: string;
    modules?: string[] | null;
  };
  return {
    token: data.token,
    expires_in: data.expires_in,
    tenant_id: data.tenant_id,
    role: data.role,
    modules: data.modules ?? [],
  };
}
