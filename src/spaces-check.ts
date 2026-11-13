// -- ClaudeCode 2026-11-12 03:14 PM PST: OFFLINE check of the lsp_spaces_* tools.
// No network: global fetch is replaced by a recorder before any handler runs.
// Proves (1) every lsp_spaces_* tool has a name, description, input schema and a
// handler; (2) the module is registered under id `spaces` in the HTTP transport
// and is filtered by the JWT `modules` claim; (3) each handler makes exactly one
// call with the route's method, path and fields; (4) the not-deployed guard holds.
// Run: npx tsx src/spaces-check.ts
export {}; // module marker for top-level await (no static imports: env must be set first)
delete process.env.LSP_TOKEN;
// Personal-mode placeholder so authFor() resolves; it is a fixed dummy string,
// not a credential, and it never leaves this process (fetch is stubbed).
process.env.LSP_SPACES_ADMIN_API_KEY = 'offline-check-placeholder';

type Rec = { method: string; url: string; body?: unknown; auth?: string };
const calls: Rec[] = [];
globalThis.fetch = (async (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
  calls.push({ method: init?.method ?? 'GET', url: String(url), body: init?.body ? JSON.parse(init.body) : undefined, auth: init?.headers?.Authorization });
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
}) as typeof fetch;

const spaces = await import('./services/spaces.js');
const { SERVICES } = await import('./config.js');
const { allTools, TOOL_MODULE, toolsForClaims, canCallTool } = await import('./http/tools.js');
const { requestContext } = await import('./request-context.js');

let failed = 0;
function assert(name: string, ok: boolean, detail = ''): void {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? `  (${detail})` : ''}`);
}

const BASE = SERVICES.spaces.url;
const T = '00000000-0000-4000-8000-000000000001';
const S = '00000000-0000-4000-8000-000000000002';
const C = '00000000-0000-4000-8000-000000000003';
const ID = '00000000-0000-4000-8000-000000000004';

// (1) shape
const spacesTools = spaces.tools.filter((t) => t.name.startsWith('lsp_spaces_'));
assert('spaces module exposes 27 lsp_spaces_* tools', spacesTools.length === 27, String(spacesTools.length));
for (const t of spaces.tools) {
  assert(`${t.name}: name/description/inputSchema/handler`,
    t.name.startsWith('lsp_spaces_') && t.description.length > 20
      && t.inputSchema?.type === 'object' && typeof spaces.handlers[t.name] === 'function');
  assert(`${t.name}: description names no "Human"`, !/human/i.test(t.description));
}
assert('no handler without a tool', Object.keys(spaces.handlers).every((n) => spaces.tools.some((t) => t.name === n)));
const desc = (n: string) => spaces.tools.find((t) => t.name === n)!.description;
assert('placements_list carries the scope rule',
  desc('lsp_spaces_placements_list').includes('never widen a scope to be helpful'));
for (const n of ['lsp_spaces_allow_set', 'lsp_spaces_connection_update']) {
  assert(`${n} carries the top-only rule`,
    desc(n).includes('Only the customer (the top tenant) may change this; a seat on a Space is refused.'));
}

// (2) registration + module filter
assert('every lsp_spaces_* tool is in the HTTP aggregate under module id "spaces"',
  spacesTools.every((t) => allTools.some((a) => a.name === t.name) && TOOL_MODULE[t.name] === 'spaces'));
const withSpaces = toolsForClaims({ role: 'user', modules: ['spaces'] }).map((t) => t.name);
const without = toolsForClaims({ role: 'user', modules: ['projects'] }).map((t) => t.name);
assert('role=user with module "spaces" sees all spaces tools', spacesTools.every((t) => withSpaces.includes(t.name)));
assert('role=user without "spaces" sees none and cannot call them',
  !without.some((n) => n.startsWith('lsp_spaces_'))
  && !canCallTool('lsp_spaces_placements_list', { role: 'user', modules: ['projects'] }));

assert('an admin role sees the spaces tools (as for every module)',
  spacesTools.every((t) => toolsForClaims({ role: 'admin', modules: null }).some((a) => a.name === t.name)));
assert('role=user with module "spaces" may call them', canCallTool('lsp_spaces_placements_list', { role: 'user', modules: ['spaces'] }));

// (4) the tools are switched on (2026-11-12, service verified live), and the
// not-deployed guard still holds when the flag is off (flipped in-process only).
assert('Spaces is flagged deployed', SERVICES.spaces.deployed === true);
assert('Spaces address is https on the lifespace.com domain', /^https:\/\/spaces\.lifespace\.com$/.test(SERVICES.spaces.url), SERVICES.spaces.url);
SERVICES.spaces.deployed = false;
let guarded = false;
try { await spaces.handlers.lsp_spaces_holds_list({ tenant_id: T }); } catch (e) { guarded = String(e).includes('not deployed'); }
assert('a call while not deployed throws "not deployed" and makes no request', guarded && calls.length === 0);
SERVICES.spaces.deployed = true;

// (3) route mapping — fetch is still the stub.
const cases: Array<[string, Record<string, unknown>, string, string, unknown]> = [
  ['lsp_spaces_settings_get', { tenant_id: T }, 'GET', `/v1/settings/${T}`, undefined],
  ['lsp_spaces_settings_get', { tenant_id: T, key: 'brief' }, 'GET', `/v1/settings/${T}/brief`, undefined],
  ['lsp_spaces_settings_set', { tenant_id: T, key: 'brief', value: { text: 'ZZ-FIXTURE' } }, 'PUT', `/v1/settings/${T}`, { key: 'brief', value: { text: 'ZZ-FIXTURE' } }],
  ['lsp_spaces_connections_list', { tenant_id: T }, 'GET', `/v1/connections?tenantId=${T}`, undefined],
  ['lsp_spaces_connection_add', { tenant_id: T, kind: 'mailbox', service: 'listen', label: 'ZZ-FIXTURE' }, 'POST', '/v1/connections', { tenant_id: T, kind: 'mailbox', service: 'listen', label: 'ZZ-FIXTURE' }],
  ['lsp_spaces_connection_update', { id: C, tenant_id: S, status: 'paused' }, 'PATCH', `/v1/connections/${C}`, { tenant_id: S, status: 'paused' }],
  ['lsp_spaces_space_connections', { space_tenant_id: S }, 'GET', `/v1/spaces/${S}/connections`, undefined],
  ['lsp_spaces_allow_set', { space_tenant_id: S, connection_id: C, mode: 'block' }, 'PUT', `/v1/spaces/${S}/allow/${C}`, { mode: 'block' }],
  ['lsp_spaces_placements_list', { scope: 'some', spaces: [S, T] }, 'GET', `/v1/placements?scope=some&spaces=${encodeURIComponent(`${S},${T}`)}`, undefined],
  ['lsp_spaces_placement_add', { tenant_id: T, connection_id: C, item_id: 'ZZ-FIXTURE-1', space_tenant_ids: [S] }, 'POST', '/v1/placements', { tenant_id: T, connection_id: C, item_id: 'ZZ-FIXTURE-1', space_tenant_ids: [S] }],
  ['lsp_spaces_sender_rules_list', { tenant_id: T, space_tenant_id: S }, 'GET', `/v1/sender-rules?tenantId=${T}&spaceTenantId=${S}`, undefined],
  ['lsp_spaces_sender_rules_add', { tenant_id: T, kind: 'domain', value: 'zz-fixture.example', mode: 'noise' }, 'POST', '/v1/sender-rules', { tenant_id: T, kind: 'domain', value: 'zz-fixture.example', mode: 'noise' }],
  ['lsp_spaces_sender_rules_update', { id: ID, state: 'approved' }, 'PATCH', `/v1/sender-rules/${ID}`, { state: 'approved' }],
  ['lsp_spaces_world_list', { tenant_id: T }, 'GET', `/v1/world?tenantId=${T}`, undefined],
  ['lsp_spaces_world_add', { tenant_id: T, kind: 'organisation', name: 'ZZ-FIXTURE Org' }, 'POST', '/v1/world', { tenant_id: T, kind: 'organisation', name: 'ZZ-FIXTURE Org' }],
  ['lsp_spaces_world_update', { id: ID, note: 'ZZ-FIXTURE' }, 'PATCH', `/v1/world/${ID}`, { note: 'ZZ-FIXTURE' }],
  ['lsp_spaces_holds_list', { tenant_id: T }, 'GET', `/v1/holds?tenantId=${T}`, undefined],
  ['lsp_spaces_holds_add', { tenant_id: T, placement_id: ID, question: 'ZZ-FIXTURE?' }, 'POST', '/v1/holds', { tenant_id: T, placement_id: ID, question: 'ZZ-FIXTURE?' }],
  ['lsp_spaces_holds_answer', { id: ID, answer: 'ZZ-FIXTURE' }, 'POST', `/v1/holds/${ID}/answer`, { answer: 'ZZ-FIXTURE' }],
  // -- ClaudeCode 2026-11-12 (dashboard parity):
  ['lsp_spaces_me', {}, 'GET', '/v1/me', undefined],
  ['lsp_spaces_overview', { scope: 'all' }, 'GET', '/v1/overview?scope=all', undefined],
  ['lsp_spaces_overview', { scope: 'one', space: S }, 'GET', `/v1/overview?scope=one&spaces=${S}`, undefined],
  ['lsp_spaces_connection_spaces', { connection_id: C }, 'GET', `/v1/connections/${C}/spaces`, undefined],
  ['lsp_spaces_connection_wants_set', { space_tenant_id: S, connection_id: C, text: 'ZZ-FIXTURE notices' }, 'PUT', `/v1/spaces/${S}/connections/${C}/wants`, { text: 'ZZ-FIXTURE notices' }],
  ['lsp_spaces_connect', { tenant_id: T, label: 'ZZ-FIXTURE mail', return_to: 'https://spaces.lifespace.com/' }, 'POST', '/v1/connections/connect', { tenant_id: T, label: 'ZZ-FIXTURE mail', return_to: 'https://spaces.lifespace.com/', kind: 'mail' }],
  ['lsp_spaces_connect_start', { connection_id: C }, 'POST', `/v1/connections/${C}/connect/start`, {}],
  ['lsp_spaces_connect_finish', { connection_id: C }, 'POST', `/v1/connections/${C}/connect/finish`, {}],
  ['lsp_spaces_connect_status', { connection_id: C }, 'GET', `/v1/connections/${C}/status`, undefined],
  ['lsp_spaces_read_put', { tenant_id: T, scope: 'all', text: 'ZZ-FIXTURE read' }, 'PUT', '/v1/reads', { tenant_id: T, scope: 'all', text: 'ZZ-FIXTURE read' }],
  ['lsp_spaces_placements_list', { scope: 'all', since: '2026-11-01T00:00:00Z', limit: 10 }, 'GET', `/v1/placements?scope=all&since=${encodeURIComponent('2026-11-01T00:00:00Z')}&limit=10`, undefined],
];
for (const [tool, args, method, path, body] of cases) {
  const before = calls.length;
  const res = await spaces.handlers[tool](args);
  const c = calls[calls.length - 1];
  const ok = !res.isError && calls.length === before + 1 && c.method === method && c.url === `${BASE}${path}`
    && JSON.stringify(c.body) === JSON.stringify(body);
  assert(`${tool} → ${method} ${path}`, ok, c ? `${c.method} ${c.url} ${JSON.stringify(c.body)}` : 'no call');
}
// (5) reach: every request went to the Spaces service and nowhere else (no
// Keys, Trust or Tenant), and the scope is passed through as given.
assert('every request went to the Spaces address only', calls.every((c) => c.url.startsWith(`${BASE}/v1/`)));
for (const scope of ['all', 'one', 'some']) {
  const n = calls.length;
  await spaces.handlers.lsp_spaces_placements_list(scope === 'all' ? { scope } : { scope, spaces: [S] });
  const u = new URL(calls[calls.length - 1].url);
  assert(`placements_list passes scope=${scope} through unchanged`,
    calls.length === n + 1 && u.searchParams.get('scope') === scope
      && (scope === 'all' ? !u.searchParams.has('spaces') : u.searchParams.get('spaces') === S));
}
// (6) the caller's own sign-in: in the HTTP transport the per-request bearer is
// what reaches Spaces, not the process's own credential.
await requestContext.run({ bearer: 'caller-jwt-offline-placeholder' }, async () => {
  await spaces.handlers.lsp_spaces_settings_get({ tenant_id: T });
});
assert('HTTP transport: the request carries the CALLER\'s bearer', calls[calls.length - 1].auth === 'Bearer caller-jwt-offline-placeholder');
// (7) parity tools: the connect tools tell the model to hand the address to the
// person and never open a browser; the overview tool carries the scope rule.
for (const n of ['lsp_spaces_connect', 'lsp_spaces_connect_start']) {
  assert(`${n} says the person opens the address and no browser is opened`, desc(n).includes('never open a browser'));
}
assert('overview carries the scope rule', desc('lsp_spaces_overview').includes('never widen a scope to be helpful'));
assert('the overview tool only offers scope all or one', JSON.stringify(spaces.tools.find((t) => t.name === 'lsp_spaces_overview')!.inputSchema).includes('["all","one"]'));
const covered = new Set(cases.map((c) => c[0]));
assert('every tool has a route case', spaces.tools.every((t) => covered.has(t.name)));

// input-shape guards
const before = calls.length;
const unk = await spaces.handlers.lsp_spaces_allow_set({ space_tenant_id: S, connection_id: C, mode: 'allow', extra: 1 });
assert('unknown property is refused without a request', !!unk.isError && calls.length === before);
const miss = await spaces.handlers.lsp_spaces_connection_update({ label: 'x' });
assert('missing path id is refused without a request', !!miss.isError && calls.length === before);

console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAILED`} — ${calls.length} stubbed requests, 0 network.`);
process.exit(failed === 0 ? 0 : 1);
