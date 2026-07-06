// -- ClaudeCode (2026-07-06): `lsp login` — device-code login (RFC 8628), the
// PRIMARY interactive flow for a NEW or fully-lapsed session. Prints a URL + code
// and waits; the USER opens it in the correct-tenant browser profile and approves.
// This tool NEVER auto-opens a browser (§3.2 — you run 3 Chrome profiles and it
// can't know which tenant/account is right). On approval it stores a revocable
// refresh token to ~/.lsp/<tenant>.json and silent refresh takes over from there.
// Spec: LifeSpace_Trust_TokenRefresh_Handoff.md §3.2, §4 Phase 1c.
import { saveRefresh } from './auth.js';

const TRUST_URL = process.env.LSP_TRUST_URL ?? 'https://trust.lifespace.com';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function decodeTenant(jwt: string): string | null {
  try { return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64').toString()).tenant_id ?? null; } catch { return null; }
}

export async function login(): Promise<number> {
  const aiLabel = process.env.LSP_AI_LABEL ?? `Claude Code (${process.cwd().split('/').pop()})`;
  // Optional folder-declared tenant to down-scope toward (drives which profile).
  const requestedTenant = process.env.LSP_TENANT_ID;

  const authRes = await fetch(`${TRUST_URL}/auth/device/authorize`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client: 'claude-code', ai_label: aiLabel, requested_tenant_id: requestedTenant }),
  });
  if (!authRes.ok) {
    console.error(`lsp login: could not start (${authRes.status}). Is Trust reachable?`);
    return 1;
  }
  const a = await authRes.json() as { device_code: string; user_code: string; verification_uri: string; verification_uri_complete: string; interval: number; expires_in: number };

  // Print instructions — NEVER auto-open a browser.
  console.error('');
  console.error('  ┌─ Connect this session to LifeSpace ─────────────────');
  console.error('  │');
  console.error(`  │  1. Open:  ${a.verification_uri_complete}`);
  console.error(`  │     (use the Chrome profile for the RIGHT tenant/account)`);
  console.error(`  │  2. Code:  ${a.user_code}`);
  console.error('  │  3. Sign in with Google → Approve');
  console.error('  │');
  console.error('  └─ Waiting for approval…');
  console.error('');

  const deadline = Date.now() + a.expires_in * 1000;
  let interval = Math.max(a.interval, 2) * 1000;
  while (Date.now() < deadline) {
    await sleep(interval);
    const tRes = await fetch(`${TRUST_URL}/auth/device/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_code: a.device_code }),
    });
    if (tRes.status === 200) {
      const t = await tRes.json() as { refresh_token: string; scope?: { tenant_id?: string } };
      const tenant = t.scope?.tenant_id ?? decodeTenant((t as any).access_token ?? '') ?? 'default';
      saveRefresh(tenant, t.refresh_token); // never printed
      console.error(`\n  ✅ Connected (tenant ${tenant.slice(0, 8)}…). Silent refresh is active — restart the session to use it.\n`);
      return 0;
    }
    const body = await tRes.json().catch(() => ({})) as { error?: string };
    if (body.error === 'authorization_pending') continue;
    if (body.error === 'slow_down') { interval += 2000; continue; }
    if (body.error === 'expired_token') { console.error('\n  ✗ The code expired. Run `lsp login` again.\n'); return 1; }
    if (body.error === 'access_denied') { console.error('\n  ✗ Approval was denied.\n'); return 1; }
    if (body.error === 'invalid_grant' || body.error === 'invalid_request') { console.error('\n  ✗ Login could not complete. Run `lsp login` again.\n'); return 1; }
    // any other error → keep polling until deadline
  }
  console.error('\n  ✗ Timed out waiting for approval. Run `lsp login` again.\n');
  return 1;
}
