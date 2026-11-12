// -- ClaudeCode 2026-11-12 03:14 PM PDT: OFFLINE check of the lsp_spaces_* tools.
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

type Rec = { method: string; url: string; body?: unknown };
const calls: Rec[] = [];
globalThis.fetch = (async (url: string, init?: { method?: string; body?: string }) => {
  calls.push({ method: init?.method ?? 'GET', url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
}) as typeof fetch;

const spaces = await import('./services/spaces.js');
const { SERVICES } = await import('./config.js');
const { allTools, TOOL_MODULE, toolsForClaims, canCallTool } = await import('./http/tools.js');

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
assert('spaces module exposes 18 lsp_spaces_* tools', spacesTools.length === 18, String(spacesTools.length));
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

// (4) not-deployed guard (before flipping the flag for the route checks)
assert('Spaces is flagged not deployed', SERVICES.spaces.deployed === false);
let guarded = false;
try { await spaces.handlers.lsp_spaces_holds_list({ tenant_id: T }); } catch (e) { guarded = String(e).includes('not deployed'); }
assert('a call while not deployed throws "not deployed" and makes no request', guarded && calls.length === 0);

// (3) route mapping — flip the flag in-process only, fetch is still the stub.
SERVICES.spaces.deployed = true;
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
];
for (const [tool, args, method, path, body] of cases) {
  const before = calls.length;
  const res = await spaces.handlers[tool](args);
  const c = calls[calls.length - 1];
  const ok = !res.isError && calls.length === before + 1 && c.method === method && c.url === `${BASE}${path}`
    && JSON.stringify(c.body) === JSON.stringify(body);
  assert(`${tool} → ${method} ${path}`, ok, c ? `${c.method} ${c.url} ${JSON.stringify(c.body)}` : 'no call');
}
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
