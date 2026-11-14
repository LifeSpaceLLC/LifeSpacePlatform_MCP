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
const queued: Array<{ status: number; body: unknown }> = []; // -- ClaudeCode 2026-11-13 (filter tools)
globalThis.fetch = (async (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
  calls.push({ method: init?.method ?? 'GET', url: String(url), body: init?.body ? JSON.parse(init.body) : undefined, auth: init?.headers?.Authorization });
  const next = queued.shift(); // -- ClaudeCode 2026-11-13 (filter tools): one stubbed answer, when queued
  if (next) return new Response(JSON.stringify(next.body), { status: next.status });
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
assert('spaces module exposes 46 lsp_spaces_* tools', spacesTools.length === 46, String(spacesTools.length)); // -- ClaudeCode 2026-11-13 (checks tools): +checks_list/retry, +hold_get/set (was 42) // -- ClaudeCode 2026-11-13 (filter tools): +filter_get/put/versions (was 39) // -- ClaudeCode 2026-11-13 12:53 PM PDT (sorter): +sorting_start/stop, +runs_list/compare (was 35) // -- ClaudeCode 2026-11-13 (topics): +4 topic tools (was 31) // -- ClaudeCode 2026-11-13 (add a Space): +space_add, +space_rename (was 29)
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
  // -- ClaudeCode 2026-11-13 (problems):
  ['lsp_spaces_problems', { scope: 'all' }, 'GET', '/v1/problems?scope=all', undefined],
  ['lsp_spaces_problems', { scope: 'one', space: S }, 'GET', `/v1/problems?scope=one&spaces=${S}`, undefined],
  ['lsp_spaces_refresh', { scope: 'all' }, 'POST', '/v1/connections/refresh', { scope: 'all' }],
  ['lsp_spaces_refresh', { scope: 'one', space: S }, 'POST', '/v1/connections/refresh', { scope: 'one', spaces: [S] }],
  // -- ClaudeCode 2026-11-13 (add a Space):
  ['lsp_spaces_space_add', { name: 'ZZ-FIXTURE Ari' }, 'POST', '/v1/spaces', { name: 'ZZ-FIXTURE Ari' }],
  ['lsp_spaces_space_rename', { space_id: S, name: 'ZZ-FIXTURE Home' }, 'PATCH', `/v1/spaces/${S}`, { name: 'ZZ-FIXTURE Home' }],
  // -- ClaudeCode 2026-11-13 (topics):
  ['lsp_spaces_topics_list', { space_id: S }, 'GET', `/v1/spaces/${S}/topics`, undefined],
  ['lsp_spaces_topic_add', { space_id: S, name: 'ZZ-FIXTURE topic', wants: 'ZZ-FIXTURE text', connection_ids: [C] }, 'POST', `/v1/spaces/${S}/topics`, { name: 'ZZ-FIXTURE topic', wants: 'ZZ-FIXTURE text', connection_ids: [C] }],
  ['lsp_spaces_topic_update', { topic_id: ID, wants: null, connection_ids: null }, 'PATCH', `/v1/topics/${ID}`, { wants: null, connection_ids: null }],
  ['lsp_spaces_topic_remove', { topic_id: ID }, 'DELETE', `/v1/topics/${ID}`, undefined],
  ['lsp_spaces_overview', { scope: 'topic', topic: ID }, 'GET', `/v1/overview?scope=topic&topic=${ID}`, undefined],
  ['lsp_spaces_problems', { scope: 'topic', topic: ID }, 'GET', `/v1/problems?scope=topic&topic=${ID}`, undefined],
  ['lsp_spaces_placements_list', { scope: 'topic', topic: ID }, 'GET', `/v1/placements?scope=topic&topic=${ID}`, undefined],
  // -- ClaudeCode 2026-11-13 12:53 PM PDT (sorter):
  ['lsp_spaces_sorting_start', { connection_id: C }, 'POST', `/v1/connections/${C}/sorting/start`, {}],
  ['lsp_spaces_sorting_stop', { connection_id: C }, 'POST', `/v1/connections/${C}/sorting/stop`, {}],
  ['lsp_spaces_runs_list', { connection_id: C }, 'GET', `/v1/runs?connection_id=${C}`, undefined],
  ['lsp_spaces_runs_list', { connection_id: C, limit: 5 }, 'GET', `/v1/runs?connection_id=${C}&limit=5`, undefined],
  ['lsp_spaces_runs_compare', { run_id: ID, other_run_id: S }, 'GET', `/v1/runs/${ID}/compare/${S}`, undefined],
  // -- ClaudeCode 2026-11-13 (filter tools):
  ['lsp_spaces_filter_get', { space_tenant_id: S, connection_id: C }, 'GET', `/v1/spaces/${S}/connections/${C}/filter`, undefined],
  ['lsp_spaces_filter_get', { space_tenant_id: S, connection_id: C, version: 2 }, 'GET', `/v1/spaces/${S}/connections/${C}/filter/versions/2`, undefined],
  ['lsp_spaces_filter_versions', { space_tenant_id: S, connection_id: C }, 'GET', `/v1/spaces/${S}/connections/${C}/filter/versions`, undefined],
  ['lsp_spaces_filter_put', { space_tenant_id: S, connection_id: C, file: { keywords: ['ZZ-FIXTURE word'], sender_domains: [] }, base_version: 3, lists_fingerprint: 'ZZ-FIXTURE-fp' },
    'PUT', `/v1/spaces/${S}/connections/${C}/filter`, { file: { keywords: ['ZZ-FIXTURE word'], sender_domains: [] }, base_version: 3, lists_fingerprint: 'ZZ-FIXTURE-fp' }],
  ['lsp_spaces_filter_put', { space_tenant_id: S, connection_id: C, file: { keywords: ['ZZ-FIXTURE word'] } },
    'PUT', `/v1/spaces/${S}/connections/${C}/filter`, { file: { keywords: ['ZZ-FIXTURE word'] } }],
  // -- ClaudeCode 2026-11-13 (checks tools):
  ['lsp_spaces_checks_list', { connection_id: C }, 'GET', `/v1/connections/${C}/checks`, undefined],
  ['lsp_spaces_checks_list', { connection_id: C, limit: 5 }, 'GET', `/v1/connections/${C}/checks?limit=5`, undefined],
  ['lsp_spaces_checks_list', { space_tenant_id: S, limit: 7 }, 'GET', `/v1/spaces/${S}/checks?limit=7`, undefined],
  ['lsp_spaces_checks_retry', { connection_id: C }, 'POST', `/v1/connections/${C}/checks/retry`, {}],
  ['lsp_spaces_checks_retry', { connection_id: C, check_id: ID }, 'POST', `/v1/connections/${C}/checks/retry`, { check_id: ID }],
  ['lsp_spaces_hold_get', { connection_id: C }, 'GET', `/v1/connections/${C}/hold`, undefined],
  ['lsp_spaces_hold_set', { connection_id: C, hold: true }, 'PUT', `/v1/connections/${C}/hold`, { hold: true }],
  ['lsp_spaces_hold_set', { connection_id: C, hold: false }, 'PUT', `/v1/connections/${C}/hold`, { hold: false }],
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
assert('the overview tool offers scope all, one or topic (2026-11-13 topics)', JSON.stringify(spaces.tools.find((t) => t.name === 'lsp_spaces_overview')!.inputSchema).includes('["all","one","topic"]'));
// -- ClaudeCode 2026-11-13 (problems): the new tools carry the scope rule, the
// owner-only rule, and how to act; the overview names the one-Space shared list.
for (const n of ['lsp_spaces_problems', 'lsp_spaces_refresh']) {
  assert(`${n} carries the scope rule`, desc(n).includes('never widen a scope to be helpful'));
  // -- ClaudeCode 2026-11-13 (topics): problems also takes scope topic; refresh stays all or one.
  const want = n === 'lsp_spaces_problems' ? '["all","one","topic"]' : '["all","one"]';
  assert(`${n} offers the expected scopes`, JSON.stringify(spaces.tools.find((t) => t.name === n)!.inputSchema).includes(want));
}
assert('problems says connecting again is a person\'s action', desc('lsp_spaces_problems').includes("a person's own action") && desc('lsp_spaces_problems').includes('lsp_spaces_connect_start'));
assert('refresh says it works only for the account owner\'s admin sign-in', desc('lsp_spaces_refresh').includes("only for the account owner's admin sign-in"));
assert('overview: the customer one-Space answer lists every shared connection', desc('lsp_spaces_overview').includes('EVERY shared connection'));
assert('problems and refresh descriptions name no mailbox', !/mailbox/i.test(desc('lsp_spaces_problems') + desc('lsp_spaces_refresh')));
// -- ClaudeCode 2026-11-13 (add a Space): owner-only, wall-not-folder, never delete.
for (const n of ['lsp_spaces_space_add', 'lsp_spaces_space_rename']) {
  assert(`${n} says only the account owner's admin sign-in`, desc(n).includes("only for the account owner's admin sign-in"));
  assert(`${n} says a Space is a wall, not a folder`, desc(n).includes('A Space is a wall, not a folder'));
  assert(`${n} says never delete`, /never (try to remove|delete) one/.test(desc(n)));
}
assert('space_add says add one only when the owner wants things kept apart', desc('lsp_spaces_space_add').includes('only when the owner wants things kept apart'));
{
  const n0 = calls.length;
  const extra = await spaces.handlers.lsp_spaces_space_rename({ space_id: S, name: 'x', config: { space: false } });
  const noId = await spaces.handlers.lsp_spaces_space_rename({ name: 'x' });
  assert('space_rename refuses config and a missing space_id without a request', !!extra.isError && !!noId.isError && calls.length === n0);
}
// -- ClaudeCode 2026-11-13 (topics): a topic is not a wall; remove is owner-only.
assert('topics_list says a topic is NOT a wall', desc('lsp_spaces_topics_list').includes('NOT a wall'));
assert('topic_add says use a topic, not a new Space', desc('lsp_spaces_topic_add').includes('Use a topic, not a new Space'));
assert('topic_remove says the account owner only and items stay', desc('lsp_spaces_topic_remove').includes('account owner only') && desc('lsp_spaces_topic_remove').includes('items stay'));
assert('topic descriptions name no mailbox', !/mailbox/i.test(['lsp_spaces_topics_list', 'lsp_spaces_topic_add', 'lsp_spaces_topic_update', 'lsp_spaces_topic_remove'].map(desc).join(' ')));
// -- ClaudeCode 2026-11-13 12:53 PM PDT (sorter): owner's own action, forward only,
// only when a Space wants it, stop turns reading off, the cache rule, counts only,
// and no tool for the runner's routes.
for (const n of ['lsp_spaces_sorting_start', 'lsp_spaces_sorting_stop']) {
  assert(`${n} says the account owner's own action, under their own sign-in`, desc(n).includes("the account owner's own action, under their own sign-in"));
}
assert('sorting_start says new mail only from that moment (forward only)', desc('lsp_spaces_sorting_start').includes('new mail only from that moment (forward only'));
assert('sorting_start says only when a Space wants the connection', desc('lsp_spaces_sorting_start').includes('only when a Space wants the connection'));
assert('sorting_stop says stop turns reading off', desc('lsp_spaces_sorting_stop').includes('stop turns reading off'));
for (const n of ['lsp_spaces_sorting_start', 'lsp_spaces_runs_list']) {
  assert(`${n} carries the cache rule`, desc(n).includes('Under the default cache setting, sender, subject and why an item was placed are not kept in the cloud.'));
}
assert('runs_list says a run lists counts only', desc('lsp_spaces_runs_list').includes('A run lists counts only'));
assert('runs_list says the filter on your computer\'s routes have no tool', desc('lsp_spaces_runs_list').includes('belongs to the filter on your computer alone and has no tool here')); // -- ClaudeCode 2026-11-13 (filter wording)
// -- ClaudeCode 2026-11-13 (filter wording): person-facing descriptions carry no sort/sorter/runner/judged words outside route paths.
{
  const filterDescs = ['lsp_spaces_sorting_start', 'lsp_spaces_sorting_stop', 'lsp_spaces_runs_list', 'lsp_spaces_runs_compare'].map(desc).join(' ').replace(/\/v1\/[a-z/]+/g, '').replace(/\bsorting(?=[:}])/g, ''); // route paths and the returned `sorting` key are identifiers
  assert('filter descriptions say filtering, never sort/sorting/sorter/runner/judged', /filtering/.test(filterDescs) && !/\bsort(ing|er|ed)?\b|runner|judged/i.test(filterDescs));
  assert('sorting_start/stop quote the ask-owner line in filter words', ['lsp_spaces_sorting_start', 'lsp_spaces_sorting_stop'].every((n) => desc(n).includes('Ask the account owner to start or stop filtering.')));
}
assert('no tool for /v1/sort/* or /v1/runs/start|finish', !spaces.tools.some((t) => /sort_batch|sort_judged|runs_start|runs_finish/.test(t.name))
  && !calls.some((c) => /\/v1\/sort\/|\/v1\/runs\/start|\/v1\/runs\/[^/]+\/finish/.test(c.url)));
const sorterDescs = ['lsp_spaces_sorting_start', 'lsp_spaces_sorting_stop', 'lsp_spaces_runs_list', 'lsp_spaces_runs_compare'].map(desc).join(' ');
assert('sorter descriptions name no mailbox and give no example', !/mailbox/i.test(sorterDescs) && !/for example|e\.g\./i.test(sorterDescs));
// -- ClaudeCode 2026-11-13 (filter tools): the answers as Spaces gives them, the
// "no filter yet" 404, a 409 passed through with no retry, and the filter words.
{
  const fp = 'a'.repeat(64);
  const shown = { space_tenant_id: S, connection_id: C, version: 2, lists_fingerprint: fp, updated_by: 'ZZ-FIXTURE', updated_at: '2026-11-13T00:00:00Z', file: { version: 2, keywords: ['ZZ-FIXTURE'], gmail_query: 'ZZ-FIXTURE' } };
  queued.push({ status: 200, body: shown });
  const got = await spaces.handlers.lsp_spaces_filter_get({ space_tenant_id: S, connection_id: C });
  assert('filter_get returns Spaces\' answer as is (with the built gmail_query)', !got.isError && JSON.stringify(JSON.parse(got.content[0].text)) === JSON.stringify(shown));

  queued.push({ status: 404, body: { error: 'This Space has no filter for this connection yet.', lists_fingerprint: fp } });
  const none = await spaces.handlers.lsp_spaces_filter_get({ space_tenant_id: S, connection_id: C });
  const noneBody = none.isError ? null : JSON.parse(none.content[0].text);
  assert('filter_get: the 404 before any filter is a plain "no filter yet" answer with lists_fingerprint',
    !none.isError && noneBody?.filter === null && noneBody?.lists_fingerprint === fp
      && noneBody?.message === 'This Space has no filter for this connection yet.' && noneBody?.space_tenant_id === S && noneBody?.connection_id === C);

  // -- ClaudeCode 2026-11-13 (lists truth): the 404 that carries the Space's current lists passes them through.
  const cur = { sender_domains: ['zz-fixture.example'], sender_addresses: [], sender_domain_blacklist: [], sender_address_blacklist: [] };
  queued.push({ status: 404, body: { error: 'This Space has no filter for this connection yet.', lists_fingerprint: fp, file: cur, version: null } });
  const noneLists = await spaces.handlers.lsp_spaces_filter_get({ space_tenant_id: S, connection_id: C });
  const nlBody = noneLists.isError ? null : JSON.parse(noneLists.content[0].text);
  assert('filter_get: the "no filter yet" answer carries the Space\'s current lists when Spaces sends them',
    !noneLists.isError && nlBody?.filter === null && JSON.stringify(nlBody?.lists) === JSON.stringify(cur) && nlBody?.lists_fingerprint === fp);
  assert('filter_get: no lists key when Spaces sends none', noneBody !== null && !('lists' in noneBody));
  assert('filter_put description: send only the lists you mean to change',
    spaces.tools.find((t: { name: string }) => t.name === 'lsp_spaces_filter_put')!.description.includes('send only the sender lists you mean to change'));

  queued.push({ status: 404, body: { error: 'Connection not found: x' } });
  let notFound = '';
  try { await spaces.handlers.lsp_spaces_filter_get({ space_tenant_id: S, connection_id: C }); } catch (e) { notFound = String(e); }
  assert('filter_get: any other 404 stays an error', notFound.includes('404') && notFound.includes('Connection not found'));

  queued.push({ status: 404, body: { error: 'This filter has no version 9.' } });
  let noVersion = '';
  try { await spaces.handlers.lsp_spaces_filter_get({ space_tenant_id: S, connection_id: C, version: 9 }); } catch (e) { noVersion = String(e); }
  assert('filter_get with version: a 404 stays an error', noVersion.includes('404') && noVersion.includes('no version 9'));

  const n0 = calls.length;
  queued.push({ status: 409, body: { error: 'This filter changed since you opened it.' } });
  let stale = '';
  try { await spaces.handlers.lsp_spaces_filter_put({ space_tenant_id: S, connection_id: C, file: { keywords: [] }, base_version: 1 }); } catch (e) { stale = String(e); }
  assert('filter_put: a 409 is passed through, one request, no retry', stale.includes('409') && stale.includes('This filter changed since you opened it.') && calls.length === n0 + 1);
  queued.push({ status: 409, body: { error: 'The sender lists for this Space changed since you opened them.' } });
  let listsStale = '';
  try { await spaces.handlers.lsp_spaces_filter_put({ space_tenant_id: S, connection_id: C, file: { sender_domains: [] }, base_version: 1, lists_fingerprint: fp }); } catch (e) { listsStale = String(e); }
  assert('filter_put: the lists\' 409 is passed through, no retry', listsStale.includes('409') && listsStale.includes('sender lists') && calls.length === n0 + 2);

  const n1 = calls.length;
  const extra = await spaces.handlers.lsp_spaces_filter_put({ space_tenant_id: S, connection_id: C, file: {}, gmail_query: 'x' });
  const noConn = await spaces.handlers.lsp_spaces_filter_versions({ space_tenant_id: S });
  assert('filter tools refuse an unknown property and a missing path id without a request', !!extra.isError && !!noConn.isError && calls.length === n1);

  const fd = ['lsp_spaces_filter_get', 'lsp_spaces_filter_put', 'lsp_spaces_filter_versions'].map(desc).join(' ');
  assert('filter descriptions carry no sort/sorter/runner/judged words', !/\bsort(ing|er|ed|s)?\b|runner|judged|noise list/i.test(fd));
  for (const part of ['keywords', 'keywords_skip_categories', 'sender_domains', 'sender_addresses', 'sender_domain_blacklist', 'sender_address_blacklist', 'priority_vs_noise', 'learn']) {
    assert(`filter_get and filter_put name the part ${part}`, ['lsp_spaces_filter_get', 'lsp_spaces_filter_put'].every((n) => desc(n).includes(part)));
  }
  const pd = desc('lsp_spaces_filter_put');
  for (const line of [
    'The server builds the Gmail search (gmail_query) from the file and ignores one sent in.',
    'A list left out is unchanged, and an explicit [] clears it.',
    'The four sender lists are shared by every connection of the Space',
    'When sending any list, pass the lists_fingerprint from the last get.',
    'Pass base_version (the version you read) once a filter exists',
    'A 409 means it changed: get it again and redo the change.',
    'does not retry by itself',
    "The account owner's own Claude session writes this file from the Space's look-for text",
    'no paid AI is called',
  ]) assert(`filter_put says: ${line}`, pd.includes(line));
  assert('filter descriptions give no example and name no mailbox', !/for example|e\.g\.|mailbox/i.test(fd));
}
// -- ClaudeCode 2026-11-13 (checks tools): the one-of rule, a failed retry as data, a 409 passed through, the words.
{
  const n0 = calls.length;
  const both = await spaces.handlers.lsp_spaces_checks_list({ connection_id: C, space_tenant_id: S });
  const neither = await spaces.handlers.lsp_spaces_checks_list({ limit: 5 });
  assert('checks_list: both or neither of connection_id / space_tenant_id is a plain error with no request',
    !!both.isError && !!neither.isError && calls.length === n0 && both.content[0].text.includes('exactly one of connection_id or space_tenant_id'));

  const shown = { connection_id: C, checks: [{ check_id: ID, at: '2026-11-13T00:00:00Z', finished_at: null, ok: true, failure_kind: null, reason: null, more_waiting: true, held: 0, matches: [{ space_id: S, space_name: 'ZZ-FIXTURE', count: 2 }] }] };
  queued.push({ status: 200, body: shown });
  const listed = await spaces.handlers.lsp_spaces_checks_list({ connection_id: C });
  assert('checks_list returns Spaces\' answer as is', !listed.isError && JSON.stringify(JSON.parse(listed.content[0].text)) === JSON.stringify(shown));

  const failedCheck = { ok: false, check: null, failure_kind: 'signin', reason: 'The mailbox needs reconnecting.', listen_sync: 'pending' };
  queued.push({ status: 200, body: failedCheck });
  const retried = await spaces.handlers.lsp_spaces_checks_retry({ connection_id: C });
  assert('checks_retry: a 200 with ok:false is returned as data, not an error',
    !retried.isError && JSON.stringify(JSON.parse(retried.content[0].text)) === JSON.stringify(failedCheck));

  const n1 = calls.length;
  queued.push({ status: 409, body: { error: 'ZZ-FIXTURE conflict.' } });
  let conflict = '';
  try { await spaces.handlers.lsp_spaces_hold_set({ connection_id: C, hold: true }); } catch (e) { conflict = String(e); }
  assert('hold_set: a 409 is passed through, one request, no retry', conflict.includes('409') && conflict.includes('ZZ-FIXTURE conflict.') && calls.length === n1 + 1);
  queued.push({ status: 409, body: { error: 'ZZ-FIXTURE conflict.' } });
  let conflict2 = '';
  try { await spaces.handlers.lsp_spaces_checks_retry({ connection_id: C }); } catch (e) { conflict2 = String(e); }
  assert('checks_retry: a 409 is passed through, one request, no retry', conflict2.includes('409') && calls.length === n1 + 2);

  const names = ['lsp_spaces_checks_list', 'lsp_spaces_checks_retry', 'lsp_spaces_hold_get', 'lsp_spaces_hold_set'];
  const cd = names.map(desc).join(' ');
  assert('checks/hold descriptions carry no sort/sorter/runner/judged words', !/\bsort(ing|er|ed|s)?\b|sorter|runner|judged/i.test(cd));
  assert('checks/hold descriptions give no example', !/for example|e\.g\./i.test(cd));
  for (const n of ['lsp_spaces_checks_list', 'lsp_spaces_checks_retry']) {
    assert(`${n} says what a check is (metadata only)`, desc(n).includes("Listen looking at the mailbox for what each Space's filter matches") && desc(n).includes('metadata only: sender, subject and date'));
    assert(`${n} says what more_waiting means`, desc(n).includes('more mail is waiting, and the next check continues'));
    assert(`${n} says what "Needs reconnecting" means`, desc(n).includes('The mailbox needs reconnecting.'));
  }
  for (const n of ['lsp_spaces_checks_retry', 'lsp_spaces_hold_set']) {
    assert(`${n} says what listen_sync pending/queued means`, desc(n).includes("'pending' or 'queued' means the change is saved and reaches the mailbox service with the next change or a Retry"));
  }
  assert('checks_retry says it re-sends pending filter changes first', desc('lsp_spaces_checks_retry').includes('first re-sends any pending filter changes, then runs a check now'));
  assert('hold_set says off keeps nothing, on keeps only matches up to a week',
    desc('lsp_spaces_hold_set').includes('Off (the default) means nothing is kept') && desc('lsp_spaces_hold_set').includes('only matches are kept, until read, and never longer than a week'));
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
