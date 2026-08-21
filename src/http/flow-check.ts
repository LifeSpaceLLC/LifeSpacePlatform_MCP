// ClaudeCode 2026-08-06 11:12 AM PDT
// -- ClaudeCode: offline check of Connect's browser-facing OAuth pages. Runs the
// REAL provider methods against stub Express req/res objects — no database, no
// Trust call, no Google. Proves: (1) /authorize renders the interstitial instead
// of redirecting, (2) Continue redirects into Trust SSO, (3) Cancel renders the
// terminal denied page and does not redirect, (4) the tenant picker renders the
// signed-in email prominently. Run: npx tsx src/http/flow-check.ts
import type { Request, Response } from 'express';
import { ConnectOAuthProvider } from './oauth-provider.js';
import {
  describeOrigin, clean, LABEL_MAX,
  // ClaudeCode 2026-08-19 02:06 PM PDT — the verified sign-in block + its gates.
  renderInterstitial, renderSeatRefused, statusCopy, signInLine, connectLine,
} from './interstitial.js';
import { registrationIdFromPath, isRegistrationId, resourceUrl, authorizeUrlFor, issuerFor, type RegistrationSummary } from './registrations.js';
import { renderConsent } from './tenants.js';
// ClaudeCode 2026-08-06 05:40 PM PDT — the durable transaction store, swapped for
// an in-memory one so this check stays offline (no Postgres, no Trust, no Google).
import { MemoryTxnStore, setTxnStore } from './txn-store.js';
// ClaudeCode 2026-08-13 02:38 PM PDT — the multi-membership choice logic. These
// are the real functions the OAuth flow calls; only the trust_app_roles lookup is
// stubbed, so the union/gate/grant rules under test are the shipped ones.
import {
  buildChoices, pickerNeeded, resolveGrantForChoice, grantsSubtreeReach,
  // ClaudeCode 2026-08-21 — the ONE seat rule, pure and therefore unit-testable.
  holdsSeat, type SeatRow,
  type Membership,
} from './memberships.js';
import { toolsForClaims, canCallTool } from './tools.js';

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
// ClaudeCode 2026-08-21 — THREE LINES AND A BUTTON. An unregistered sign-in can
// name neither the session nor the person, so it says exactly that and no more.
assert('unregistered sign-in states the ask in one line',
  authorize.html.includes('An app wants to connect to LifeSpace.'));
assert('unregistered sign-in names the account to use',
  authorize.html.includes('Sign in with your LifeSpace account.'));
assert('unregistered sign-in carries the single red unregistered line',
  authorize.html.includes("This connection isn&#039;t registered — the tenant is chosen after sign-in.")
  || authorize.html.includes("This connection isn't registered — the tenant is chosen after sign-in."));
assert('the button reads Continue with Google', authorize.html.includes('href="/oauth/continue"')
  && authorize.html.includes('>Continue with Google</a>'));
assert('the wrong-browser copy line is the copy action',
  authorize.html.includes('Wrong browser? Copy this link and open it there.') && authorize.html.includes('id="copybtn"'));
assert('interstitial carries the full authorize URL for the copy action',
  authorize.html.includes(`https://connect.lifespace.com${AUTHORIZE_QS.replace(/&/g, '&amp;')}`));
// Greg, 2026-08-21: everything that is not one of those lines is off the page.
for (const gone of ['Requested by', 'Requesting tool', 'What it gets', 'Next step', 'unverified', 'Cancel', 'Details']) {
  assert(`sign-in page does not render "${gone}"`, !authorize.html.includes(gone));
}
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
assert('the origin line is derived correctly but is no longer rendered on the page',
  describeOrigin('https://claude.ai/api/mcp/auth_callback') === 'claude.ai' && !authorize.html.includes('Requested by'));

// Untrusted label / hint: present, escaped, capped, and never described as verified.
const evilLabel = '<img src=x onerror=alert(1)>Coach Simple folder';
const hintReq: Partial<Request> = {
  originalUrl: `${AUTHORIZE_QS}&label=${encodeURIComponent(evilLabel)}&tenant_hint=${encodeURIComponent('Coach Simple')}`,
  query: { label: evilLabel, tenant_hint: 'Coach Simple' },
  headers: {},
};
const { res: hRes, out: hinted } = stubRes(hintReq);
await provider.authorize(client, { ...(params as object) } as never, hRes);
// ClaudeCode 2026-08-21 — caller-supplied `label` / `tenant_hint` no longer reach
// the sign-in page AT ALL. They used to be rendered in an amber "unverified"
// block; on a three-line page there is nowhere for an untrusted claim to live, so
// the safest possible treatment is the one now in force — don't render it. (They
// still preselect a radio in the tenant picker, which is checked below.)
assert('a caller-supplied label never reaches the sign-in page',
  !hinted.html.includes('Coach Simple folder') && !hinted.html.includes('img src=x') && !hinted.html.includes('&lt;img'));
assert('a caller-supplied tenant hint never reaches the sign-in page',
  !hinted.html.includes('Expects tenant') && !hinted.html.includes('This request says it is from'));
assert('the word "unverified" appears nowhere on the sign-in page', !/unverified/i.test(hinted.html));
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

// ---------------------------------------------------------------------------
// ClaudeCode 2026-08-13 02:40 PM PDT — REGRESSION: the multi-membership identity.
// jon@coachsimple.net holds TWO role rows on the Connect app (user@Coach Simple
// and user@Curriculum Rebuild, 12 modules each) and got NO picker: the gate was
// `role === 'admin'`, and the list was the winning row's SUBTREE — which for a
// role=user is just their own tenant, so two sibling MEMBERSHIPS could never
// merge into one list. He was silently connected to whichever row Trust's SSO
// exchange returned. These checks pin the union list, the count-based gate, and
// the grant carried by the chosen row.
const JON: Membership[] = [
  { tenantId: 'cs-01ecd85f', tenantName: 'Coach Simple', role: 'user', modules: ['projects', 'knowledge'] },
  { tenantId: 'cr-4162bcb9', tenantName: 'Curriculum Rebuild', role: 'user', modules: ['tickets'] },
];
const SOLO: Membership[] = [JON[0]];

const jonChoices = await buildChoices(JON);
assert('two-membership identity is offered BOTH tenants',
  jonChoices.length === 2 && jonChoices.map((c) => c.id).join(',') === 'cs-01ecd85f,cr-4162bcb9',
  jonChoices.map((c) => c.name).join(' | '));
assert('the picker renders for a plain role=user with two memberships', pickerNeeded(jonChoices));
assert('both tenant NAMES reach the page',
  renderConsent('c3', 'jon@coachsimple.net', 'cs-01ecd85f', jonChoices, 'Claude').includes('Coach Simple')
  && renderConsent('c3', 'jon@coachsimple.net', 'cs-01ecd85f', jonChoices, 'Claude').includes('Curriculum Rebuild'));

const soloChoices = await buildChoices(SOLO);
assert('single-membership identity still skips the picker',
  soloChoices.length === 1 && !pickerNeeded(soloChoices));

// The grant follows the CHOSEN row — this is the half of the bug that was
// invisible: the auth code used to record the OTHER row's role + modules.
const gCS = resolveGrantForChoice(JON, 'cs-01ecd85f', { role: 'user', modules: ['tickets'] });
assert('choosing Coach Simple grants Coach Simple\'s modules, not the other row\'s',
  gCS.tenantId === 'cs-01ecd85f' && gCS.modules.join(',') === 'projects,knowledge', gCS.modules.join(','));
const gCR = resolveGrantForChoice(JON, 'cr-4162bcb9', { role: 'user', modules: ['projects', 'knowledge'] });
assert('choosing Curriculum Rebuild grants Curriculum Rebuild\'s modules',
  gCR.tenantId === 'cr-4162bcb9' && gCR.modules.join(',') === 'tickets', gCR.modules.join(','));
assert('a role=user membership reaches exactly one tenant (no subtree)', !grantsSubtreeReach('user'));
assert('an admin membership still reaches its subtree',
  grantsSubtreeReach('admin') && grantsSubtreeReach('super_admin'));

// ---------------------------------------------------------------------------
// ClaudeCode 2026-08-13 02:44 PM PDT — "which tenant am I in?" is always
// answerable. lsp_trust_whoami is in the admin-only `trust` module, so a
// role=user connector could hold a dozen granted modules and still be unable to
// state its own tenant — the exact question this bug made people ask.
const userClaims = { role: 'user', modules: ['projects'] };
const names = toolsForClaims(userClaims).map((t) => t.name);
assert('role=user sees lsp_trust_whoami even without the trust module', names.includes('lsp_trust_whoami'));
assert('role=user can CALL lsp_trust_whoami', canCallTool('lsp_trust_whoami', userClaims));
assert('the whoami carve-out does not leak the rest of the trust module',
  !names.includes('lsp_trust_users_list') && !canCallTool('lsp_trust_users_list', userClaims));
assert('module filtering is otherwise unchanged',
  names.some((n) => n.startsWith('lsp_projects_')) && !names.some((n) => n.startsWith('lsp_keys_')));

// ---------------------------------------------------------------------------
// ClaudeCode 2026-08-19 02:08 PM PDT — VERIFIED SIGN-IN PAGE. The whole point of
// the registration is that the page stops repeating caller-typed text and starts
// stating server records. These checks pin (a) that the id can only arrive
// structurally, (b) that each validity state renders and gates Continue the way
// it claims to, and (c) that a seat mismatch is a hard stop, not a fallback.
const REG_ID = '7f3a1c92-4b8e-4d21-9a6f-2c5e8b10d4a3';

assert('a registration id is read off the resource path',
  registrationIdFromPath(`/mcp/r/${REG_ID}`) === REG_ID);
assert('a registration id is read off the authorize path',
  registrationIdFromPath(`/authorize/r/${REG_ID}?client_id=x`) === REG_ID);
assert('a registration id is read off an absolute RFC 8707 resource URL',
  registrationIdFromPath(`https://connect.lifespace.com/mcp/r/${REG_ID}`) === REG_ID);
// The id must NOT be forgeable through the query string — that is the entire
// difference between this page and the 08-06 "unverified" one.
assert('a ?registration_id= query param is NOT a registration',
  registrationIdFromPath(`/authorize?registration_id=${REG_ID}`) === undefined);
assert('a non-uuid path segment is not a registration',
  registrationIdFromPath('/mcp/r/not-a-uuid') === undefined && !isRegistrationId('not-a-uuid'));
assert('the legacy /mcp path carries no registration',
  registrationIdFromPath('/mcp') === undefined);
assert('resource / authorize / issuer URLs agree on the id',
  resourceUrl(REG_ID).endsWith(`/mcp/r/${REG_ID}`)
  && authorizeUrlFor(REG_ID).endsWith(`/authorize/r/${REG_ID}`)
  && issuerFor(REG_ID).endsWith(`/r/${REG_ID}`));

const SUMMARY: RegistrationSummary = {
  registration_id: REG_ID,
  status: 'active',
  session_label: 'CS - Coach Simple - Platform work',
  folder_label: '~/_git/CoachSimple',
  tenant: { id: '01ecd85f-0000-0000-0000-000000000000', short_id: '01ecd85f', name: 'Coach Simple' },
  intended_email: 'gausley@coachsimple.net',
  intended_role: 'admin',
  seats: [
    { email: 'gausley@coachsimple.net', role: 'admin', kind: 'account' },
    { email: '*@coachsimple.net', role: 'user', kind: 'domain' },
  ],
  created_at: '2026-08-19T18:00:00.000Z',
  created_by: 'gausley@coachsimple.net',
  expires_at: null,
  revoked_at: null,
  last_used_at: null,
  resource_url: resourceUrl(REG_ID),
  sign_in_url: authorizeUrlFor(REG_ID),
};

// ClaudeCode 2026-08-21 — DEFECT 2: the page rendered `seats`, i.e. the tenant's
// whole roster, under "Sign in as" — six addresses on a real client tenant. A
// registration names ONE person; the page names that person and nobody else.
assert('line 1 names the session and the tenant',
  connectLine(SUMMARY) === '<b>CS - Coach Simple - Platform work</b> wants to connect to <b>Coach Simple</b>.',
  connectLine(SUMMARY));
assert('line 2 names the ONE intended account',
  signInLine(SUMMARY) === 'Sign in with <b>gausley@coachsimple.net</b>.', signInLine(SUMMARY));
assert('with no intended account, line 2 falls back to the seat sentence — never a roster',
  signInLine({ ...SUMMARY, intended_email: null }) === 'Sign in with an account that has a seat on <b>Coach Simple</b>.',
  signInLine({ ...SUMMARY, intended_email: null }));

const activePage = renderInterstitial({
  clientName: 'Claude', continueUrl: '/oauth/continue', cancelUrl: '/oauth/cancel',
  authorizeUrl: authorizeUrlFor(REG_ID), origin: 'a local program on this computer (port 51234)',
  summary: SUMMARY,
});
assert('an ACTIVE registration offers Continue with Google',
  activePage.includes('href="/oauth/continue"') && activePage.includes('>Continue with Google</a>'));
assert('the registered page is the same three lines',
  activePage.includes('wants to connect to <b>Coach Simple</b>.')
  && activePage.includes('Sign in with <b>gausley@coachsimple.net</b>.')
  && activePage.includes('Wrong browser? Copy this link and open it there.'));
assert('the registered page renders NO roster',
  !activePage.includes('*@coachsimple.net') && !activePage.includes('domain grant') && !activePage.includes('Accounts with a seat'));
// The registration id survives only inside the hidden copy-link value — the
// person never READS it. Assert against the visible text, not the markup.
const activeVisible = activePage.replace(/<script[\s\S]*?<\/script>/g, '')
  .replace(/<style[\s\S]*?<\/style>/g, '').replace(/<input[^>]*>/g, '')
  .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
assert('the registered page shows no validity, id, issuer or origin detail',
  !activeVisible.includes(REG_ID.slice(0, 8)) && !activeVisible.includes('Active')
  && !activeVisible.includes('issued') && !activeVisible.includes('Requested by')
  && !activeVisible.includes('01ecd85f'), activeVisible);
assert('the word "unverified" appears nowhere on a registered sign-in page', !/unverified/i.test(activePage));

for (const dead of ['revoked', 'expired'] as const) {
  const page = renderInterstitial({
    clientName: 'Claude', continueUrl: '/oauth/continue', cancelUrl: '/oauth/cancel',
    authorizeUrl: authorizeUrlFor(REG_ID), origin: 'claude.ai',
    summary: { ...SUMMARY, status: dead, revoked_at: dead === 'revoked' ? '2026-08-19T19:00:00.000Z' : null },
  });
  assert(`a ${dead} registration says so in one line and REFUSES Continue`,
    page.includes(dead === 'revoked' ? 'This connection was revoked.' : 'This connection has expired.')
    && !page.includes('href="/oauth/continue"') && page.includes('btn-disabled'));
}

const unregistered = renderInterstitial({
  clientName: 'Claude', continueUrl: '/oauth/continue', cancelUrl: '/oauth/cancel',
  authorizeUrl: 'https://connect.lifespace.com/authorize?client_id=x', origin: 'claude.ai',
});
assert('a LEGACY unregistered sign-in still offers Continue (nothing breaks today)',
  unregistered.includes('href="/oauth/continue"'));
assert('a legacy sign-in uses the same three-line shape',
  unregistered.includes('An app wants to connect to LifeSpace.')
  && unregistered.includes('Sign in with your LifeSpace account.'));
assert('a legacy sign-in carries exactly one red unregistered line',
  unregistered.includes('class="stop"') && /the tenant is chosen after sign-in/.test(unregistered)
  && (unregistered.match(/class="stop"/g) ?? []).length === 1);

const unknown = renderInterstitial({
  clientName: 'Claude', continueUrl: '/oauth/continue', cancelUrl: '/oauth/cancel',
  authorizeUrl: authorizeUrlFor(REG_ID), origin: 'claude.ai',
  summary: { ...SUMMARY, status: 'unknown', session_label: null, folder_label: null, tenant: null, seats: [], intended_email: null, intended_role: null },
});
assert('an id with no registration reads as unregistered', /the tenant is chosen after sign-in/.test(unknown));
assert('an unknown registration refuses Continue', !unknown.includes('href="/oauth/continue"'));

assert('only an ACTIVE registration may continue',
  statusCopy('active').ok && !statusCopy('revoked').ok && !statusCopy('expired').ok && !statusCopy('unknown').ok);

const seatRefusedPage = renderSeatRefused({
  email: 'greg@personal.example',
  tenantName: 'Coach Simple',
  intendedEmail: 'gausley@coachsimple.net',
  retryUrl: authorizeUrlFor(REG_ID),
});
assert('the hard-stop leads with "That\'s not the right account."',
  seatRefusedPage.includes('That&#039;s not the right account.') || seatRefusedPage.includes("That's not the right account."));
assert('the hard-stop names the ONE account to use',
  seatRefusedPage.includes('Sign in with <b>gausley@coachsimple.net</b>.'));
assert('the hard-stop lists no roster',
  !seatRefusedPage.includes('*@coachsimple.net') && !seatRefusedPage.includes('Accounts with a seat'));
assert('the hard-stop offers Try again and nothing else',
  seatRefusedPage.includes('>Try again</a>') && !seatRefusedPage.includes('/oauth/continue'));
assert('with no intended account the hard-stop still names no roster',
  renderSeatRefused({ email: 'x@y.z', tenantName: 'Coach Simple', intendedEmail: null })
    .includes('an account that has a seat on <b>Coach Simple</b>'));

// ---------------------------------------------------------------------------
// ClaudeCode 2026-08-21 — DEFECT 1 REGRESSION: the FALSE HARD-STOP.
//
// Greg opened the registration for tenant Coach Simple, signed in as
// gausley@coachsimple.net — who holds an ADMIN row on Coach Simple for the
// Connect app — and was told he had no seat there. The guard was asking
// `buildChoices(resolveMemberships(email)).some(t => t.id === reg.tenantId)`,
// which is not the seat question: `resolveMemberships` mirrors Trust's
// resolution ORDER, so the moment an identity holds ANY exact-email row, every
// `*@domain` grant it also holds is discarded. The sign-in page, meanwhile, read
// trust_app_roles directly. Two predicates, two answers, one accusation.
//
// `holdsSeat` is now the only predicate, and these cases pin it.
const CS = '01ecd85f-0e6d-471b-98a8-e06b02207874';        // Coach Simple
const ROOT = '542330f7-4c0b-4237-b932-2af8c9c32514';      // LifeSpace Platform (its parent)
const CR = '4162bcb9-8109-4f85-9e1e-0c425c17992c';        // Curriculum Rebuild (its child)
const CS_ANCESTORS = new Set([ROOT]);

// Greg's actual rows on the Connect app, as they stand in production.
const GREG_ROWS: SeatRow[] = [{ email: 'gausley@coachsimple.net', role: 'admin', tenantId: CS }];
assert('DEFECT 1 — an admin row ON the registered tenant IS a seat',
  holdsSeat(GREG_ROWS, 'gausley@coachsimple.net', CS, CS_ANCESTORS));

// The shape that made the old guard lie: an exact row somewhere else PLUS a
// domain grant on the registered tenant. resolveMemberships drops the domain row
// because an exact row exists, so buildChoices never offered Coach Simple —
// while the page listed `*@coachsimple.net` as a seat holder on it.
const MIXED: SeatRow[] = [
  { email: 'gausley@coachsimple.net', role: 'admin', tenantId: CR },
  { email: '*@coachsimple.net', role: 'user', tenantId: CS },
];
assert('DEFECT 1 — a domain grant is a seat even when an exact row exists elsewhere',
  holdsSeat(MIXED, 'gausley@coachsimple.net', CS, CS_ANCESTORS));
// The old predicate, reconstructed offline (the real one calls getSubtreeTree,
// which needs Postgres). Step 1 is resolveMemberships' collapse: an exact-email
// row exists, so the `*@coachsimple.net` row is DISCARDED. Step 2 is buildChoices:
// the surviving admin row reaches its own tenant plus DESCENDANTS — and Coach
// Simple is the PARENT of Curriculum Rebuild, not a descendant. Refusal.
const descendantsOf: Record<string, string[]> = { [ROOT]: [CS, CR], [CS]: [CR], [CR]: [] };
const oldPredicate = (() => {
  const exact = MIXED.filter((r) => r.email === 'gausley@coachsimple.net');
  const chosen = exact.length > 0 ? exact : MIXED;             // the collapse
  const reachable = new Set<string>();
  for (const r of chosen) {
    reachable.add(r.tenantId);
    if (grantsSubtreeReach(r.role)) for (const d of descendantsOf[r.tenantId] ?? []) reachable.add(d);
  }
  return reachable.has(CS);
})();
assert('DEFECT 1 — the OLD guard refused that same person (this is the bug)', oldPredicate === false);

assert('an admin row on an ANCESTOR reaches down into the registered tenant',
  holdsSeat([{ email: 'gausley@lifespace.com', role: 'super_admin', tenantId: ROOT }],
    'gausley@lifespace.com', CS, CS_ANCESTORS));
assert('a plain user row on an ancestor does NOT reach down',
  !holdsSeat([{ email: 'someone@lifespace.com', role: 'user', tenantId: ROOT }],
    'someone@lifespace.com', CS, CS_ANCESTORS));
assert('a row on a DESCENDANT is not a seat on the registered tenant',
  !holdsSeat([{ email: 'jon@coachsimple.net', role: 'admin', tenantId: CR }],
    'jon@coachsimple.net', CS, CS_ANCESTORS));
assert('a different person\'s row is never a seat',
  !holdsSeat(GREG_ROWS, 'someone.else@coachsimple.net', CS, CS_ANCESTORS));
assert('a domain grant only matches its own domain',
  !holdsSeat([{ email: '*@coachsimple.net', role: 'admin', tenantId: CS }],
    'greg@personal.example', CS, CS_ANCESTORS));
assert('address matching is case- and whitespace-insensitive',
  holdsSeat([{ email: '  GAusley@CoachSimple.net ', role: 'admin', tenantId: CS }],
    'gausley@coachsimple.net', CS, CS_ANCESTORS));

console.log('\n--- registered sign-in page (visible copy) ---');
console.log(activePage.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '')
  .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());

console.log('\n--- hard-stop page (visible copy) ---');
console.log(seatRefusedPage.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());

console.log('\n--- interstitial text (visible copy) ---');
console.log(authorize.html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '')
  .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
console.log('\n--- cancelled page text ---');
console.log(cancelled.html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
