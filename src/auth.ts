// -- ClaudeCode (2026-07-06): Trust Auth v2 (Phase 1b) — MCP-side token lifecycle.
// Zero-touch migration + silent refresh-on-401 for the LSP_TOKEN (briefing/agent)
// path. Personal mode (per-service admin keys) is untouched — this is a no-op there.
//
// Flow:
//   startup → ensureReady(): decode LSP_TOKEN → tenant; load stored refresh from
//     keychain (fallback ~/.lsp/<tenant>.json). If none AND LSP_TOKEN still valid,
//     silently exchange it for a revocable refresh token (§3.7 zero-touch). The 50
//     sessions migrate invisibly on their next reconnect.
//   on 401 → refreshAccessToken(): /auth/renew (rotating) → swap access, PERSIST the
//     rotated refresh BEFORE using the new access, retry once.
//
// Invariants honored: access token memory-only (§3.5); refresh token durable +
// hashed server-side; never printed. Back-compat: if Trust is unreachable or has
// no refresh yet, we fall back to the raw LSP_TOKEN so nothing that works today breaks.
// Spec: LifeSpace_Trust_TokenRefresh_Handoff.md §3.5–3.7, §4 Phase 1.
//
// STORAGE (revised 2026-07-06, deviates from §3.5 "keychain primary"):
// The macOS `security` CLI, called from this HEADLESS stdio MCP process, triggers
// a GUI keychain-authorization prompt — which would pop/hang on EVERY session boot,
// on every machine. So the gitignored file store (~/.lsp/<tenant>.json, mode 600)
// is PRIMARY; the OS keychain is OPT-IN via LSP_USE_KEYCHAIN=1 (sensible only for
// GUI-launched clients like Claude Desktop where the ACL grants silently). The file
// store is the exact fallback the spec already blesses — same security posture,
// zero prompts. Deviation flagged to Greg after keychain popups observed 2026-07-06.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const TRUST_URL = process.env.LSP_TRUST_URL ?? 'https://trust.lifespace.com';
const KEYCHAIN_SERVICE = 'lifespace-mcp';
const REFRESH_PREFIX = 'lsr_';
const FETCH_TIMEOUT_MS = 8000;

interface Stored { refresh_token: string; tenant_id: string }

const mem: { accessToken: string | null; refreshToken: string | null; tenantId: string | null } = {
  accessToken: null,
  refreshToken: null,
  tenantId: null,
};

/** True when running in single-bearer LSP_TOKEN mode (the only mode with a
 *  refresh lifecycle). Personal per-service-key mode returns false → all the
 *  logic here is skipped. */
export function isTokenMode(): boolean {
  return !!process.env.LSP_TOKEN;
}

// -- ClaudeCode (2026-07-11, Execute B3-blocker-3): SINGLE-REFRESHER RULE.
// Only the Execute WORKER may read/refresh/write ~/.lsp/<tenant>.json. A
// per-run MCP server (spawned by the worker for one `claude -p`) is given a
// token via LSP_TOKEN and set LSP_NO_REFRESH=1 — it NEVER touches the store and
// NEVER refreshes. If its token expires mid-run it just fails that call cleanly;
// the worker refreshes and the NEXT run gets a fresh token. This kills the
// multi-process rotation race that cross-stomped the store (session drift
// 542330f7→8d43ee3f, 2026-07-11). See [[reference_electron_worker_runtime_gotchas]].
export function noRefreshMode(): boolean {
  return process.env.LSP_NO_REFRESH === '1';
}

// -- ClaudeCode 2026-08-11 03:52 PM PDT: adopt a freshly renewed STATIC token
// (token-renewal.ts) into the running process, so a renewal takes effect without a
// restart. Updating process.env.LSP_TOKEN is what makes it stick: authFor() and
// currentBearer() both read it, as does the next renewal check. The access-token
// slot is cleared rather than set — the renewed 30-day token is now the freshest
// credential we hold, and any stale short-lived access token must not shadow it.
export function adoptRenewedToken(freshToken: string): void {
  process.env.LSP_TOKEN = freshToken;
  mem.accessToken = null;
}

function decodeClaims(jwt: string): Record<string, any> | null {
  try {
    return JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64').toString());
  } catch {
    return null;
  }
}

function isJwtExpired(jwt: string, skewSec = 120): boolean {
  const c = decodeClaims(jwt);
  if (!c?.exp) return true;
  return c.exp * 1000 < Date.now() + skewSec * 1000;
}

// ─── Storage: keychain primary, ~/.lsp/<tenant>.json fallback (mode 600) ────────
function lspDir(): string {
  return join(homedir(), '.lsp');
}
function fileStorePath(tenant: string): string {
  return join(lspDir(), `${tenant}.json`);
}

// Keychain is OFF by default (it prompts from a headless process). Opt-in only.
function keychainEnabled(): boolean {
  return process.env.LSP_USE_KEYCHAIN === '1' && process.platform === 'darwin';
}

function keychainSet(tenant: string, json: string): boolean {
  if (!keychainEnabled()) return false;
  try {
    // -U = update if present. Single-user Mac; same pattern as gh/railway.
    execFileSync('security', ['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', tenant, '-w', json], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

function keychainGet(tenant: string): string | null {
  if (!keychainEnabled()) return null;
  try {
    const out = execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', tenant, '-w'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const s = out.toString().trim();
    return s || null;
  } catch {
    return null;
  }
}

export function saveRefresh(tenant: string, refreshToken: string): void {
  const payload: Stored = { refresh_token: refreshToken, tenant_id: tenant };
  const json = JSON.stringify(payload);
  // PRIMARY: gitignored file, mode 600. Never prompts.
  let okFile = false;
  try {
    if (!existsSync(lspDir())) mkdirSync(lspDir(), { recursive: true, mode: 0o700 });
    writeFileSync(fileStorePath(tenant), json, { mode: 0o600 });
    okFile = true;
  } catch { /* handled below */ }
  // OPT-IN: keychain (no-op unless LSP_USE_KEYCHAIN=1 on macOS).
  const okKeychain = keychainSet(tenant, json);
  if (!okFile && !okKeychain) {
    console.error('[lsp-auth] WARNING: could not persist refresh token to ~/.lsp (or keychain).');
  }
}

function loadRefresh(tenant: string): string | null {
  // PRIMARY: file store first — never prompts.
  try {
    const raw = readFileSync(fileStorePath(tenant), 'utf8');
    const p = JSON.parse(raw) as Stored;
    if (p.refresh_token?.startsWith(REFRESH_PREFIX)) return p.refresh_token;
  } catch { /* try keychain if opted in */ }
  const fromKeychain = keychainGet(tenant); // no-op unless opted in
  if (fromKeychain) {
    try {
      const p = JSON.parse(fromKeychain) as Stored;
      if (p.refresh_token?.startsWith(REFRESH_PREFIX)) return p.refresh_token;
    } catch { /* none */ }
  }
  return null;
}

// ─── HTTP helpers (with timeout so boot can never hang on a dead Trust) ─────────
async function trustPost(path: string, body: unknown, bearer?: string): Promise<{ status: number; body: any }> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    const res = await fetch(`${TRUST_URL}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body ?? {}),
      signal: ac.signal,
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, body: json };
  } finally {
    clearTimeout(t);
  }
}

// ─── Public API ────────────────────────────────────────────────────────────────
let readyPromise: Promise<void> | null = null;

/** Idempotent, memoized. Loads the stored refresh token and, if absent but the
 *  static token is still valid, performs the zero-touch migration. Never throws —
 *  every failure leaves the static LSP_TOKEN path intact (back-compat). */
export function ensureReady(): Promise<void> {
  if (!isTokenMode()) return Promise.resolve();
  // No-refresh (per-run worker MCP): use LSP_TOKEN as-is; never read/migrate/
  // write the store. Single-refresher rule — the worker owns ~/.lsp.
  if (noRefreshMode()) return Promise.resolve();
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    try {
      const staticTok = process.env.LSP_TOKEN!;
      const claims = decodeClaims(staticTok);
      const tenant = claims?.tenant_id;
      if (!tenant) return; // can't key storage; stay on static token
      mem.tenantId = tenant;

      const stored = loadRefresh(tenant);
      if (stored) {
        mem.refreshToken = stored;
        // If the static access token is already expired, proactively get a fresh
        // one now so the first tool call doesn't have to eat a 401 round-trip.
        if (isJwtExpired(staticTok)) await refreshAccessToken();
        return;
      }

      // No refresh stored yet → zero-touch migration, but only if the static
      // token is still valid to present as the migration credential.
      if (isJwtExpired(staticTok)) {
        console.error('[lsp-auth] static LSP_TOKEN expired and no refresh token stored — run `lsp login` (device flow).');
        return;
      }
      const ex = await trustPost('/auth/exchange-token', { client: 'claude-code', ai_label: claims?.name ?? 'MCP session' }, staticTok);
      if (ex.status === 200 && ex.body.refresh_token?.startsWith(REFRESH_PREFIX)) {
        mem.refreshToken = ex.body.refresh_token;
        mem.accessToken = ex.body.access_token ?? null;
        saveRefresh(tenant, ex.body.refresh_token);
        console.error('[lsp-auth] migrated to revocable refresh token — silent refresh active.');
      } else {
        console.error(`[lsp-auth] migration skipped (status ${ex.status}); continuing on static token.`);
      }
    } catch (e) {
      console.error('[lsp-auth] init non-fatal error; continuing on static token:', (e as Error).message);
    }
  })();
  return readyPromise;
}

/** The bearer to present to LSP services. Prefers a live in-memory access token,
 *  then the static LSP_TOKEN (back-compat), else null (→ personal-mode keys). */
export function currentBearer(): string | null {
  if (mem.accessToken && !isJwtExpired(mem.accessToken, 30)) return mem.accessToken;
  const staticTok = process.env.LSP_TOKEN;
  if (staticTok && !isJwtExpired(staticTok, 0)) return staticTok;
  // Static expired but we may have a refresh — return the (stale) access if any;
  // the 401 path will trigger a refresh. If nothing usable, null.
  return mem.accessToken ?? staticTok ?? null;
}

/** Exchange the stored refresh token for a fresh access token. Rotates: persists
 *  the NEW refresh token before returning so a crash can't strand us on a burned
 *  token mid-swap. Returns false if we have no refresh or Trust rejects it. */
export async function refreshAccessToken(): Promise<boolean> {
  // Per-run worker MCP never refreshes — a mid-run 401 fails the call cleanly
  // (the worker is the sole refresher; the next run gets a fresh token).
  if (noRefreshMode()) return false;
  if (!mem.refreshToken || !mem.tenantId) return false;
  try {
    const r = await trustPost('/auth/renew', { refresh_token: mem.refreshToken });
    if (r.status === 200 && r.body.token) {
      if (r.body.refresh_token?.startsWith(REFRESH_PREFIX)) {
        // Persist rotated refresh FIRST (before serving the new access token).
        saveRefresh(mem.tenantId, r.body.refresh_token);
        mem.refreshToken = r.body.refresh_token;
      }
      mem.accessToken = r.body.token;
      return true;
    }
    // 401/403 → refresh is dead (revoked/expired/blocked/rotated-away). Drop it.
    console.error(`[lsp-auth] refresh rejected (status ${r.status}) — run \`lsp login\` to re-auth.`);
    mem.refreshToken = null;
    return false;
  } catch (e) {
    console.error('[lsp-auth] refresh error:', (e as Error).message);
    return false;
  }
}
