// -- ClaudeCode 2026-08-11 03:52 PM PDT: self-renewing folder token.
//
// THE PROBLEM: every project folder's .mcp.json carries a 30-day agent JWT in
// env.LSP_TOKEN. When it lapses, every lsp_* call 401s and a human has to mint,
// install and restart. Scheduled routines and long-lived sessions die silently.
//
// THE FIX: on boot, and once every 24h while running, this module checks its own
// LSP_TOKEN's exp. Inside the renewal window it calls Trust POST /v1/agents/renew,
// rewrites env.LSP_TOKEN in its own .mcp.json in place, and swaps the bearer in the
// RUNNING process — so there is no restart either.
//
// RELATIONSHIP TO auth.ts (they solve different halves, do not confuse them):
//   auth.ts   = the in-memory session lifecycle. Exchanges LSP_TOKEN for a
//               revocable refresh token in ~/.lsp and silently renews the ACCESS
//               token on 401. Fixes mid-session death; the file on disk still rots.
//   this file = the ON-DISK credential. Keeps .mcp.json itself current, so a fresh
//               process (a scheduled routine, a new session, a wiped ~/.lsp, a new
//               machine) still boots with a live token. Fixes the 30-day cliff.
//
// SAFETY RAILS:
//   - SINGLE-REFRESHER RULE (see auth.ts): a per-run worker MCP (LSP_NO_REFRESH=1)
//     NEVER renews and NEVER writes. The worker owns the credential store; a
//     per-run child rewriting .mcp.json is exactly the cross-stomp that caused the
//     2026-07-11 session drift.
//   - The config file is identified by TOKEN EQUALITY, not by guessing: we only
//     rewrite an entry whose env.LSP_TOKEN is byte-identical to the one we booted
//     with. A folder whose token belongs to another tenant is never touched.
//   - Atomic write (tmp file + rename) so a crash mid-write cannot truncate the
//     user's .mcp.json.
//   - The token is NEVER printed — not in logs, not in warnings, not in the alert
//     email. Only expiry dates and folder paths.
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { isTokenMode, noRefreshMode, adoptRenewedToken } from './auth.js';

const TRUST_URL = process.env.LSP_TRUST_URL ?? 'https://trust.lifespace.com';
const FETCH_TIMEOUT_MS = 10000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Renew once the token is inside this many days of expiry. Mirrors the 7-day
 *  post-expiry grace Trust allows, so the window is symmetric: 7 days before, 7
 *  days after. A 30-day token therefore has 14 days of chances to self-heal. */
const RENEW_WITHIN_DAYS = 7;
const GRACE_DAYS = 7;
const CHECK_INTERVAL_MS = DAY_MS;
/** One alert email per config file per 72h, however often renewal is retried. */
const ALERT_COOLDOWN_MS = 72 * 60 * 60 * 1000;

function log(msg: string): void {
  console.error(`[lsp-token] ${msg}`);
}

function decodeClaims(token: string): Record<string, any> | null {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64').toString());
  } catch {
    return null;
  }
}

function expiryDate(token: string): Date | null {
  const exp = decodeClaims(token)?.exp;
  return typeof exp === 'number' ? new Date(exp * 1000) : null;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ─── Finding our own .mcp.json ─────────────────────────────────────────────────

interface ConfigHit {
  path: string;
  /** Parsed document — rewritten wholesale on save. */
  doc: any;
  /** Server keys under mcpServers whose env.LSP_TOKEN matches ours. */
  serverKeys: string[];
}

/** Candidate config paths, most-specific first: an explicit override, then every
 *  ancestor of cwd (Claude Code spawns the stdio server with cwd = project dir),
 *  then the platform checkout if LSP_REPO_PATH is set. */
function candidatePaths(): string[] {
  const out: string[] = [];
  const explicit = process.env.LSP_MCP_CONFIG_PATH;
  if (explicit) out.push(resolve(explicit));
  let dir = process.cwd();
  for (let i = 0; i < 12; i++) {
    out.push(join(dir, '.mcp.json'));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (process.env.LSP_REPO_PATH) out.push(join(process.env.LSP_REPO_PATH, '.mcp.json'));
  return [...new Set(out)];
}

/** Locate the config entry that actually carries OUR token. Identity is exact
 *  string equality with the booted LSP_TOKEN — never a name or path heuristic. */
function findConfig(currentToken: string): ConfigHit | null {
  for (const path of candidatePaths()) {
    if (!existsSync(path)) continue;
    let doc: any;
    try {
      doc = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      continue; // malformed or not ours — keep looking
    }
    const servers = doc?.mcpServers;
    if (!servers || typeof servers !== 'object') continue;
    const serverKeys = Object.keys(servers).filter(
      (k) => servers[k]?.env?.LSP_TOKEN === currentToken,
    );
    if (serverKeys.length) return { path, doc, serverKeys };
  }
  return null;
}

/** Rewrite env.LSP_TOKEN for the matched entries, preserving everything else in
 *  the document. Atomic: write a sibling temp file, then rename over the target. */
function writeConfig(hit: ConfigHit, freshToken: string): void {
  for (const key of hit.serverKeys) {
    hit.doc.mcpServers[key].env.LSP_TOKEN = freshToken;
  }
  const tmp = `${hit.path}.lsp-renew-${process.pid}.tmp`;
  const serialized = `${JSON.stringify(hit.doc, null, 2)}\n`;
  try {
    writeFileSync(tmp, serialized, { mode: 0o600 });
    renameSync(tmp, hit.path); // atomic on the same filesystem
  } catch (e) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch { /* best effort */ }
    throw e;
  }
}

// ─── Alert suppression state ───────────────────────────────────────────────────
// Kept in ~/.lsp (the established credential-adjacent store) rather than beside
// .mcp.json, so renewal never drops an untracked dotfile into a user's repo and
// dirties their git status. Keyed by a hash of the config path.

function alertStatePath(): string {
  return join(homedir(), '.lsp', 'token-renewal-alerts.json');
}

function alertKey(configPath: string | null): string {
  return createHash('sha256').update(configPath ?? 'unknown-config').digest('hex').slice(0, 16);
}

function readAlertState(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(alertStatePath(), 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

function shouldAlert(configPath: string | null): boolean {
  const last = readAlertState()[alertKey(configPath)];
  if (!last) return true;
  const at = Date.parse(last);
  return !Number.isFinite(at) || Date.now() - at > ALERT_COOLDOWN_MS;
}

function markAlerted(configPath: string | null): void {
  try {
    const dir = dirname(alertStatePath());
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const state = readAlertState();
    state[alertKey(configPath)] = new Date().toISOString();
    writeFileSync(alertStatePath(), JSON.stringify(state), { mode: 0o600 });
  } catch { /* alerting is best-effort; never break the server over it */ }
}

// ─── The alert email (best effort, never throws) ───────────────────────────────

async function sendFailureAlert(token: string, configPath: string | null, expiresAt: Date): Promise<void> {
  if (!shouldAlert(configPath)) return;
  const claims = decodeClaims(token);
  // Dispatch has to actually be granted to this identity, or the call just 403s.
  const modules: string[] | undefined = claims?.modules;
  if (claims?.role === 'user' && !(Array.isArray(modules) && modules.includes('dispatch'))) return;
  const to = process.env.LSP_RENEWAL_ALERT_EMAIL ?? 'gausley@coachsimple.net';
  const folder = configPath ? dirname(configPath) : process.cwd();
  try {
    const { call } = await import('./client.js');
    await call('dispatch', '/v1/send', 'POST', {
      channel: 'email',
      recipient: to,
      subject: `A folder token could not renew and dies ${ymd(expiresAt)}`,
      body:
        `A folder token could not renew and dies ${ymd(expiresAt)}: ${folder}\n\n` +
        `Config: ${configPath ?? '(not found — LSP_TOKEN set but no matching .mcp.json)'}\n` +
        `Tenant: ${claims?.tenant_id ?? 'unknown'}\n` +
        `Identity: ${claims?.email ?? 'unknown'}\n\n` +
        `Renewal is retried every 24h and for 7 days after expiry. If it keeps failing, ` +
        `mint a replacement token for this folder.`,
    });
    markAlerted(configPath);
    log('renewal-failure alert emailed.');
  } catch (e) {
    // Suppress for 72h anyway — a Dispatch outage must not become a mail storm.
    markAlerted(configPath);
    log(`could not send renewal-failure alert: ${(e as Error).message}`);
  }
}

// ─── Renewal ───────────────────────────────────────────────────────────────────

async function renewWithTrust(token: string): Promise<{ ok: true; token: string; expiresAt: Date } | { ok: false; status: number; error: string }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${TRUST_URL}/v1/agents/renew`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
      signal: ac.signal,
    });
    const body = (await res.json().catch(() => ({}))) as { token?: string; expires_at?: string; error?: string };
    if ((res.status === 200 || res.status === 201) && body.token) {
      return { ok: true, token: body.token, expiresAt: new Date(body.expires_at ?? Date.now() + 30 * DAY_MS) };
    }
    return { ok: false, status: res.status, error: body.error ?? `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, status: 0, error: (e as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

/** One renewal check. Never throws — a token problem must never take the MCP
 *  server down; the worst case is that we keep running on the old token. */
export async function checkAndRenewToken(): Promise<void> {
  try {
    if (!isTokenMode()) return;                         // personal per-service keys
    if (noRefreshMode()) return;                        // per-run worker child
    if (process.env.LSP_TOKEN_AUTORENEW === '0') return; // explicit opt-out

    const token = process.env.LSP_TOKEN!;
    const expiresAt = expiryDate(token);
    if (!expiresAt) return;                             // not a JWT we can reason about

    const msLeft = expiresAt.getTime() - Date.now();
    if (msLeft > RENEW_WITHIN_DAYS * DAY_MS) return;    // plenty of runway
    if (msLeft < -GRACE_DAYS * DAY_MS) {
      // Past Trust's grace — renewal is impossible, a human must re-mint.
      log(`WARNING: this folder's LSP token EXPIRED ${ymd(expiresAt)} and is past the ${GRACE_DAYS}-day renewal grace. Mint a new token for ${process.cwd()}.`);
      const hit = findConfig(token);
      await sendFailureAlert(token, hit?.path ?? null, expiresAt);
      return;
    }

    const hit = findConfig(token);
    const result = await renewWithTrust(token);
    if (!result.ok) {
      log(`WARNING: LSP token renewal FAILED (${result.status || 'network'}: ${result.error}). This folder's token expires ${ymd(expiresAt)} — running on the old token until then. Folder: ${hit ? dirname(hit.path) : process.cwd()}`);
      await sendFailureAlert(token, hit?.path ?? null, expiresAt);
      return;
    }

    // Swap in the running process FIRST — even if the disk write fails, this
    // session is already healed.
    adoptRenewedToken(result.token);

    if (!hit) {
      log(`LSP token renewed through ${ymd(result.expiresAt)} (in-memory only — no .mcp.json carrying this token was found; the file on disk still holds the old one).`);
      return;
    }
    try {
      writeConfig(hit, result.token);
      log(`LSP token renewed through ${ymd(result.expiresAt)}`);
    } catch (e) {
      log(`WARNING: token renewed but ${hit.path} could not be rewritten (${(e as Error).message}). This session is fine; the next fresh process will still use the old token, which expires ${ymd(expiresAt)}.`);
      await sendFailureAlert(token, hit.path, expiresAt);
    }
  } catch (e) {
    log(`renewal check error (non-fatal): ${(e as Error).message}`);
  }
}

/** Boot hook: check now, then once every 24h for the life of the process. */
export function startTokenRenewal(): void {
  void checkAndRenewToken();
  const timer = setInterval(() => void checkAndRenewToken(), CHECK_INTERVAL_MS);
  timer.unref?.(); // never hold the process open on our account
}
