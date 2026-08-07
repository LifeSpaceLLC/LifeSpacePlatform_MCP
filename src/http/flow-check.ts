// ClaudeCode 2026-08-06 11:12 AM PDT
// -- ClaudeCode: offline check of Connect's browser-facing OAuth pages. Runs the
// REAL provider methods against stub Express req/res objects — no database, no
// Trust call, no Google. Proves: (1) /authorize renders the interstitial instead
// of redirecting, (2) Continue redirects into Trust SSO, (3) Cancel renders the
// terminal denied page and does not redirect, (4) the tenant picker renders the
// signed-in email prominently. Run: npx tsx src/http/flow-check.ts
import type { Request, Response } from 'express';
import { ConnectOAuthProvider } from './oauth-provider.js';
import { describeOrigin, clean, LABEL_MAX } from './interstitial.js';
import { renderConsent } from './tenants.js';
// ClaudeCode 2026-08-06 05:40 PM PDT — the durable transaction store, swapped for
// an in-memory one so this check stays offline (no Postgres, no Trust, no Google).
import { MemoryTxnStore, setTxnStore } from './txn-store.js';

process.env.CONNECT_BASE_URL ??= 'https://connect.lifespace.com';
process.env.TRUST_BASE_URL ??= 'https://trust.lifespace.com';
process.env.CONNECT_TRUST_APP_ID ??= '00000000-0000-0000-0000-000000000000';
// db.ts requires the var at import time; nothing here ever opens a connection.
process.env.DATABASE_URL ??= 'postgres://offline-flow-check/none';

const store = new MemoryTxnStore();
setTxnStore(store);

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

// ClaudeCode 2026-08-06 11:36 AM PDT — origin line + caller self-description.
assert('origin: loopback redirect_uri reads as a local program',
  describeOrigin('http://127.0.0.1:6274/oauth/callback') === 'a local program on this computer (port 6274)',
  describeOrigin('http://127.0.0.1:6274/oauth/callback'));
assert('origin: claude.ai callback reads as claude.ai', describeOrigin('https://claude.ai/api/mcp/auth_callback') === 'claude.ai');
assert('origin: anything else shows the host plainly', describeOrigin('https://weird.example.com/cb') === 'weird.example.com');
assert('origin: garbage redirect_uri degrades safely', describeOrigin('not-a-url') === 'an unrecognized destination');
assert('interstitial renders the derived origin line', authorize.html.includes('Requested by: <b>claude.ai</b>'));

// Untrusted label / hint: present, escaped, capped, and never described as verified.
const evilLabel = '<img src=x onerror=alert(1)>Coach Simple folder';
const hintReq: Partial<Request> = {
  originalUrl: `${AUTHORIZE_QS}&label=${encodeURIComponent(evilLabel)}&tenant_hint=${encodeURIComponent('Coach Simple')}`,
  query: { label: evilLabel, tenant_hint: 'Coach Simple' },
  headers: {},
};
const { res: hRes, out: hinted } = stubRes(hintReq);
await provider.authorize(client, { ...(params as object) } as never, hRes);
assert('label is rendered as TEXT, never markup', hinted.html.includes('&lt;img src=x onerror=alert(1)&gt;') && !hinted.html.includes('<img src=x'));
assert('label + tenant hint shown as the caller\'s own claim',
  hinted.html.includes('This request says it is from:') && hinted.html.includes('Expects tenant: <b>Coach Simple</b>'));
assert('hint is not presented as verified', hinted.html.includes('LifeSpace cannot verify it'));
// Spoofing guard: the caller's claim must SAY "unverified" and be styled apart
// from the server-verified facts (registered client name + derived origin).
assert('claim block carries the visible word "unverified"', /This request says it is from:[\s\S]{0,300}unverified/i.test(hinted.html));
assert('claim block is styled distinctly from verified facts',
  hinted.html.includes('class="claim"') && hinted.html.includes('class="tag">unverified'));
assert('verified facts stay in their own blocks', hinted.html.includes('class="who">Requested by') && hinted.html.includes('Requesting tool'));
assert('footer states the unverified convention', hinted.html.includes("Anything this page can't verify is marked unverified."));
assert('over-long label is capped', (clean('x'.repeat(500), LABEL_MAX) ?? '').length === LABEL_MAX + 1);

// tenant_hint preselects the matching radio in the picker — still a confirmation.
const tree = [
  { id: 'tenant-1', name: 'LifeSpace Platform', type: 'root', depth: 0 },
  { id: 'tenant-2', name: 'Coach Simple', type: 'client', depth: 1 },
];
const preselected = renderConsent('c1', 'greg@lifespace.com', 'tenant-2', tree, 'Claude', 'Coach Simple folder', 'Coach Simple');
assert('picker preselects the hinted tenant',
  /value="tenant-2" checked/.test(preselected) && !/value="tenant-1" checked/.test(preselected));
assert('picker still requires a submit (no auto-submit script)', !/\.submit\(\)/.test(preselected));
assert('picker repeats the label as an unverified claim',
  preselected.includes('Coach Simple folder') && preselected.includes('class="claim"') && /unverified/.test(preselected));
// A hint can only highlight a row the server already put in the list.
const spoofed = renderConsent('c2', 'greg@lifespace.com', 'tenant-1', tree, 'Claude', 'Totally Legit', 'Some Other Tenant');
assert('hint for a tenant the user does not hold adds no row + preselects nothing new',
  !spoofed.includes('Some Other Tenant"') && /value="tenant-1" checked/.test(spoofed) && (spoofed.match(/type="radio"/g) ?? []).length === 2);

// ---------------------------------------------------------------------------
// ClaudeCode 2026-08-06 05:42 PM PDT — REGRESSION: the 2026-08-06 Connect outage.
// The interstitial stretched the /authorize→Trust-callback window from one
// automatic 302 into a human-paced Google sign-in. While the held request lived
// in a process-local Map, a redeploy or restart inside that window destroyed it:
// the callback then dead-ended on connect.lifespace.com with "Sign-in session
// expired or not found", and because the client's redirect_uri was ONLY in that
// lost entry, the MCP client's loopback listener never received a single hit.
// These three checks pin the fix: the transaction is written to the durable
// store, a FRESH provider (a restarted process) can still complete the flow, and
// it is consumed exactly once.
const { res: rRes, out: restartAuth } = stubRes({ originalUrl: AUTHORIZE_QS, headers: {} });
await provider.authorize(client, params, rRes);
const rCookie = restartAuth.cookies[restartAuth.cookies.length - 1] ?? '';

assert('held /authorize request is written to the durable store, not process memory',
  (await store.size()) > 0);

// A brand-new provider instance == the process that just came back from a deploy.
const restarted = new ConnectOAuthProvider();
const { res: rgRes, out: rCont } = stubRes({ headers: { cookie: rCookie } });
await restarted.handleContinue({ headers: { cookie: rCookie } } as Request, rgRes);
assert('Continue still works after a process restart',
  rCont.status === 302 && (rCont.redirect ?? '').startsWith('https://trust.lifespace.com/auth/google?'), rCont.redirect);

const { res: rcbRes, out: rCb } = stubRes({ headers: { cookie: rCookie } });
await restarted.handleTrustCallback({ headers: { cookie: rCookie }, query: {} } as unknown as Request, rcbRes);
const rBack = new URL(rCb.redirect ?? 'https://invalid.example');
assert('Trust callback after a restart still reaches the client (no dead-end 400)',
  rCb.status === 302 && rBack.origin + rBack.pathname === 'https://claude.ai/api/mcp/auth_callback',
  `${rCb.status} ${rCb.redirect ?? rCb.html.slice(0, 60)}`);
assert('restarted callback preserves the original state', rBack.searchParams.get('state') === 'xyz123');

// Consumed exactly once — a replayed callback must not resurrect the request.
const { res: r2Res, out: rCb2 } = stubRes({ headers: { cookie: rCookie } });
await restarted.handleTrustCallback({ headers: { cookie: rCookie }, query: {} } as unknown as Request, r2Res);
assert('held request is single-use (replayed callback gets nothing)', rCb2.status === 400 && !rCb2.redirect);

// ---------------------------------------------------------------------------
// ClaudeCode 2026-08-06 07:20 PM PDT — REGRESSION: identity refused by Trust.
// gausley@coachsimple.net has no role assignment on the lifespace-connect Trust
// app, so Trust returns ?sso_error=Not authorized — no role assignment found.
// That used to be bounced to the client as a bare `error=access_denied`, and
// mcp-remote — which discards error_description — rendered it as "Error: No
// authorization code received". Hours were spent hunting a code bug that did not
// exist. An identity refusal is not client-retryable, so it now terminates HERE
// with the reason on screen.
const REFUSAL = 'Not authorized — no role assignment found';
const { res: xRes, out: refusedAuth } = stubRes({ originalUrl: AUTHORIZE_QS, headers: {} });
await provider.authorize(client, params, xRes);
const xCookie = refusedAuth.cookies[refusedAuth.cookies.length - 1] ?? '';

const { res: xcbRes, out: refused } = stubRes({ headers: { cookie: xCookie } });
await provider.handleTrustCallback(
  { headers: { cookie: xCookie }, query: { sso_error: REFUSAL } } as unknown as Request, xcbRes);

assert('Trust identity refusal does NOT bounce to the client as a bare OAuth error', !refused.redirect);
assert('Trust identity refusal terminates on Connect with 403', refused.status === 403, String(refused.status));
assert('refusal page states the reason Trust gave', refused.html.includes(REFUSAL));
assert('refusal page says what to do about it',
  /granted access to LifeSpace Connect/.test(refused.html) && refused.html.includes('Nothing was connected'));

// Technical/transient failures stay client-retryable, so they keep the spec-shaped
// error redirect — only the identity refusal changed shape.
const { res: yRes, out: noCodeAuth } = stubRes({ originalUrl: AUTHORIZE_QS, headers: {} });
await provider.authorize(client, params, yRes);
const yCookie = noCodeAuth.cookies[noCodeAuth.cookies.length - 1] ?? '';
const { res: ycbRes, out: noCode } = stubRes({ headers: { cookie: yCookie } });
await provider.handleTrustCallback({ headers: { cookie: yCookie }, query: {} } as unknown as Request, ycbRes);
assert('a transient callback failure still redirects to the client', noCode.status === 302 &&
  (noCode.redirect ?? '').startsWith('https://claude.ai/api/mcp/auth_callback?error=access_denied'), noCode.redirect);

console.log('\n--- interstitial text (visible copy) ---');
console.log(authorize.html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '')
  .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
console.log('\n--- cancelled page text ---');
console.log(cancelled.html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
