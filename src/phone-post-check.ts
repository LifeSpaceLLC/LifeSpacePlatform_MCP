// -- ClaudeCode 2026-11-18 (phone post): OFFLINE check of lsp_dispatch_phone_post.
// No network: global fetch is replaced by a recorder before any handler runs.
// Proves (1) the schema: the six fields, three required, no recipient, unknown keys refused,
// lines at most 3, urgency normal|urgent; (2) Connect registers the same handler under the
// dispatch module; (3) under the Connect request context it makes exactly one POST to Dispatch
// /v1/inbox/post with the caller's JWT, the args as the body, and NO X-Tenant-Id header;
// (4) an unknown key (a recipient included) is an error and makes no request;
// (5) lsp_dispatch_send is unchanged (its channel enum still has no 'app').
// Run: npx tsx src/phone-post-check.ts
export {}; // module marker for top-level await (no static imports: env must be set first)
delete process.env.LSP_TOKEN;
// Personal-mode placeholder (NOT JWT-shaped) so authFor() resolves outside the Connect context;
// a fixed dummy string, not a credential, and it never leaves this process.
process.env.LSP_DISPATCH_ADMIN_API_KEY = 'offline-check-placeholder';

type Rec = { method: string; url: string; body?: unknown; headers: Record<string, string> };
const calls: Rec[] = [];
globalThis.fetch = (async (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
  calls.push({
    method: init?.method ?? 'GET',
    url: String(url),
    body: init?.body ? JSON.parse(init.body) : undefined,
    headers: { ...(init?.headers ?? {}) },
  });
  return new Response(JSON.stringify({ item_id: 'i', message_id: 'm', push: 'skipped' }), { status: 200 });
}) as typeof fetch;

const dispatch = await import('./services/dispatch.js');
const { allHandlers, TOOL_MODULE } = await import('./http/tools.js');
const { requestContext } = await import('./request-context.js');
const { SERVICES } = await import('./config.js');

let failed = 0;
function assert(name: string, ok: boolean, detail = ''): void {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? `  (${detail})` : ''}`);
}
const hdr = (r: Rec, h: string) => Object.entries(r.headers).find(([k]) => k.toLowerCase() === h.toLowerCase())?.[1];

const NAME = 'lsp_dispatch_phone_post';
const SPACE = '00000000-0000-4000-8000-0000000000a1';
const CALLER_JWT = 'offline.placeholder.jwt'; // JWT-SHAPED placeholder, not a real token

// (1) schema
type Schema = { properties: Record<string, any>; required: string[]; additionalProperties?: boolean };
const tool = dispatch.tools.find((t) => t.name === NAME);
const schema = tool?.inputSchema as unknown as Schema;
assert('tool exists', !!tool);
assert('properties = exactly the six fields',
  JSON.stringify(Object.keys(schema.properties).sort()) === JSON.stringify(['full_text', 'idempotency_key', 'lines', 'space_tenant_id', 'title', 'urgency']));
assert('required = space_tenant_id, title, idempotency_key',
  JSON.stringify([...schema.required].sort()) === JSON.stringify(['idempotency_key', 'space_tenant_id', 'title']));
assert('no recipient field', !('recipient' in schema.properties));
assert('additionalProperties false', schema.additionalProperties === false);
assert('lines: array of strings, at most 3',
  schema.properties.lines.type === 'array' && schema.properties.lines.items.type === 'string' && schema.properties.lines.maxItems === 3);
assert('urgency enum normal|urgent', JSON.stringify(schema.properties.urgency.enum) === JSON.stringify(['normal', 'urgent']));
const d = tool?.description ?? '';
assert('description says: your own phone, never anyone else, push on urgent, idempotency, 20 a day',
  d.includes('YOUR OWN phone') && d.includes('never sends to anyone else') && d.includes("'urgent' also sends a push")
    && d.includes('idempotency_key is required') && d.includes('At most 20 posts a day per Space'));

// (2) registration
assert('Connect registers the same handler', allHandlers[NAME] === dispatch.handlers[NAME]);
assert('Connect files it under the dispatch module', TOOL_MODULE[NAME] === 'dispatch');

// (3) the call, under the Connect request context
const args = { space_tenant_id: SPACE, title: 'Found it', lines: ['a', 'b'], full_text: 'detail', urgency: 'urgent', idempotency_key: 'k-1' };
await requestContext.run({ bearer: CALLER_JWT }, async () => {
  calls.length = 0;
  const out = await dispatch.handlers[NAME](args) as { isError?: boolean; content: Array<{ text: string }> };
  const r = calls[0];
  assert('exactly one request', calls.length === 1, String(calls.length));
  assert('POST to Dispatch /v1/inbox/post', r.method === 'POST' && r.url === `${SERVICES.dispatch.url}/v1/inbox/post`, `${r.method} ${r.url}`);
  assert("caller's JWT carried", hdr(r, 'authorization') === `Bearer ${CALLER_JWT}`);
  assert('no X-Tenant-Id header', hdr(r, 'x-tenant-id') === undefined);
  assert('body = the args exactly', JSON.stringify(r.body) === JSON.stringify(args));
  assert('result passed back', !out.isError && out.content[0].text.includes('"item_id"'));

  // (4) unknown keys refused, no request
  for (const extra of [{ recipient: 'someone@example.com' }, { tenant_id: SPACE }, { config: {} }]) {
    calls.length = 0;
    const bad = await dispatch.handlers[NAME]({ ...args, ...extra }) as { isError?: boolean; content: Array<{ text: string }> };
    const k = Object.keys(extra)[0];
    assert(`unknown key ${k} → error, no request`,
      bad.isError === true && bad.content[0].text.includes(`lsp_dispatch_phone_post: ${k}`) && calls.length === 0, bad.content[0].text);
  }
});

// (5) lsp_dispatch_send unchanged
const send = dispatch.tools.find((t) => t.name === 'lsp_dispatch_send')?.inputSchema as unknown as Schema;
assert("lsp_dispatch_send channel enum unchanged (no 'app')",
  JSON.stringify(send.properties.channel.enum) === JSON.stringify(['sms', 'email', 'slack', 'telegram', 'pushover']));

console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAILED`} — 0 network.`);
process.exit(failed === 0 ? 0 : 1);
