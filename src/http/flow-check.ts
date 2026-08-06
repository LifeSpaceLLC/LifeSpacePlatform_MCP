// ClaudeCode 2026-08-06 11:12 AM PDT
// -- ClaudeCode: offline check of Connect's browser-facing OAuth pages. Runs the
// REAL provider methods against stub Express req/res objects — no database, no
// Trust call, no Google. Proves: (1) /authorize renders the interstitial instead
// of redirecting, (2) Continue redirects into Trust SSO, (3) Cancel renders the
// terminal denied page and does not redirect, (4) the tenant picker renders the
// signed-in email prominently. Run: npx tsx src/http/flow-check.ts
import type { Request, Response } from 'express';
import { ConnectOAuthProvider } from './oauth-provider.js';
import { renderConsent } from './tenants.js';

process.env.CONNECT_BASE_URL ??= 'https://connect.lifespace.com';
process.env.TRUST_BASE_URL ??= 'https://trust.lifespace.com';
process.env.CONNECT_TRUST_APP_ID ??= '00000000-0000-0000-0000-000000000000';

interface Captured { status: number; html: string; redirect?: string; cookies: string[] }

function stubRes(req: Partial<Request>): { res: Response; out: Captured } {
  const out: Captured = { status: 200, html: '', cookies: [] };
  const res = {
    req,
    headersSent: false,
    status(c: number) { out.status = c; return this; },
    type() { return this; },
    send(body: string) { out.html = body; return this; },
    redirect(code: number, url: string) { out.status = code; out.redirect = url; return this; },
    // The txn value is a session handle — kept in the object so the next hop can
    // present it, never printed (only an 8-char prefix is ever logged).
    cookie(name: string, value: string) { out.cookies.push(`${name}=${value}`); return this; },
    clearCookie() { return this; },
  } as unknown as Response;
  return { res, out };
}

function assert(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) process.exitCode = 1;
}

const provider = new ConnectOAuthProvider();
const AUTHORIZE_QS =
  '/authorize?response_type=code&client_id=test-client-1&redirect_uri=https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fauth_callback' +
  '&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256&state=xyz123&scope=projects';

const client = {
  client_id: 'test-client-1',
  client_name: 'Claude',
  redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
} as never;

const params = {
  redirectUri: 'https://claude.ai/api/mcp/auth_callback',
  state: 'xyz123',
  codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  scopes: ['projects'],
} as never;

const authorizeReq: Partial<Request> = { originalUrl: AUTHORIZE_QS, headers: {} };
const { res: aRes, out: authorize } = stubRes(authorizeReq);
await provider.authorize(client, params, aRes);

assert('/authorize renders HTML, does not redirect to Google', !authorize.redirect && authorize.html.includes('<!DOCTYPE html>'));
assert('interstitial states the product + the ask',
  authorize.html.includes('LifeSpace Connect') && authorize.html.includes('A tool connection is asking to sign in.'));
assert('interstitial names the requesting client', authorize.html.includes('<b>Claude</b>'));
assert('interstitial offers Continue + Cancel',
  authorize.html.includes('href="/oauth/continue"') && authorize.html.includes('href="/oauth/cancel"'));
assert('interstitial carries the full authorize URL for the copy button',
  authorize.html.includes(`https://connect.lifespace.com${AUTHORIZE_QS.replace(/&/g, '&amp;')}`));
assert('no auto-redirect (no meta refresh / location assignment)',
  !/http-equiv=["']refresh/i.test(authorize.html) && !/location\s*(\.href)?\s*=/.test(authorize.html));
assert('connect_txn cookie set', authorize.cookies.some((c) => c.startsWith('connect_txn=')));

// Continue — the cookie the interstitial got back is what carries the request.
const cookieHeader = authorize.cookies[0] ?? '';
const txn = /connect_txn=(.+)$/.exec(cookieHeader)?.[1] ?? '';
console.log(`\n(OAuth request held server-side under connect_txn ${txn.slice(0, 8)}… — value never printed in full)`);

const { res: goRes, out: cont } = stubRes({ headers: { cookie: cookieHeader } });
await provider.handleContinue({ headers: { cookie: cookieHeader } } as Request, goRes);
assert('Continue redirects into Trust SSO (Google leg)',
  cont.status === 302 && (cont.redirect ?? '').startsWith('https://trust.lifespace.com/auth/google?'),
  cont.redirect);
assert('Continue sends Trust our callback, not the client redirect_uri',
  (cont.redirect ?? '').includes('redirect_uri=https%3A%2F%2Fconnect.lifespace.com%2Foauth%2Ftrust%2Fcallback'));

// Param preservation: the held request must come back out of the callback leg
// exactly as it went in. Driving the callback with no sso_code makes it bounce to
// the CLIENT's redirect_uri with the ORIGINAL state — which is only possible if
// redirect_uri + state survived the interstitial + Continue hops untouched.
const { res: cbRes, out: cb } = stubRes({ headers: { cookie: cookieHeader } });
await provider.handleTrustCallback({ headers: { cookie: cookieHeader }, query: {} } as unknown as Request, cbRes);
const back = new URL(cb.redirect ?? 'https://invalid.example');
assert('OAuth params survive: client redirect_uri preserved',
  back.origin + back.pathname === 'https://claude.ai/api/mcp/auth_callback', back.origin + back.pathname);
assert('OAuth params survive: state preserved', back.searchParams.get('state') === 'xyz123', String(back.searchParams.get('state')));

// Cancel — terminal page, no redirect anywhere.
const { res: cRes, out: cancelled } = stubRes({ headers: {} });
await provider.handleCancel({ headers: {} } as Request, cRes);
assert('Cancel renders the denied page', cancelled.html.includes('Sign-in cancelled') && cancelled.html.includes('no access was granted'));
assert('Cancel does not redirect', !cancelled.redirect);

// Continue with an unknown/expired cookie must not leak into Google either.
const { res: kRes, out: stale } = stubRes({ headers: {} });
await provider.handleContinue({ headers: {} } as Request, kRes);
assert('Continue without a held request → 400 explanation, no redirect', stale.status === 400 && !stale.redirect);

// Tenant picker template (rendered directly — the DB lookup that feeds it is the
// only part that needs Postgres, and it is not what we are checking here).
const picker = renderConsent('consent-abc', 'greg@lifespace.com', 'tenant-1', [
  { id: 'tenant-1', name: 'LifeSpace Platform', type: 'root', depth: 0 },
  { id: 'tenant-2', name: 'Realcomm', type: 'client', depth: 1 },
], 'Claude');
assert('picker states the signed-in email prominently', picker.includes('class="who"') && picker.includes('<b>greg@lifespace.com</b>'));
assert('picker offers the wrong-profile escape', picker.includes('not you?') && picker.includes('/oauth/cancel'));
assert('picker lists tenant NAMES', picker.includes('LifeSpace Platform') && picker.includes('Realcomm'));
assert('picker names the requesting tool', picker.includes('<b>Claude</b>'));

console.log('\n--- interstitial text (visible copy) ---');
console.log(authorize.html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '')
  .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
console.log('\n--- cancelled page text ---');
console.log(cancelled.html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
