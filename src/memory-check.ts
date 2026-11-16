// -- ClaudeCode 2026-11-15 (space facts): OFFLINE check of the lsp_memory_* tenant_id.
// No network: global fetch is replaced by a recorder before any handler runs.
// Proves (1) all five memory tools expose an optional tenant_id; (2) each
// handler puts tenant_id in the X-Tenant-Id header and NEVER in the body;
// (3) absent tenant_id sends no header; (4) a non-uuid tenant_id is a plain
// error and makes no request; (5) under the Connect request context (the
// caller's Trust JWT bound via AsyncLocalStorage) the header still reaches the
// downstream request alongside that JWT; (6) an API-key sign-in is refused a
// tenant_id (Memory's key path ignores the header).
// Run: npx tsx src/memory-check.ts
export {}; // module marker for top-level await (no static imports: env must be set first)
delete process.env.LSP_TOKEN;
// Personal-mode placeholder (NOT JWT-shaped) so authFor() resolves; a fixed
// dummy string, not a credential, and it never leaves this process.
process.env.LSP_MEMORY_ADMIN_API_KEY = 'offline-check-placeholder';

type Rec = { method: string; url: string; body?: unknown; headers: Record<string, string> };
const calls: Rec[] = [];
globalThis.fetch = (async (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
  calls.push({
    method: init?.method ?? 'GET',
    url: String(url),
    body: init?.body ? JSON.parse(init.body) : undefined,
    headers: { ...(init?.headers ?? {}) },
  });
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
}) as typeof fetch;

const memory = await import('./services/memory.js');
const { allHandlers } = await import('./http/tools.js');
const { requestContext } = await import('./request-context.js');

let failed = 0;
function assert(name: string, ok: boolean, detail = ''): void {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? `  (${detail})` : ''}`);
}

const SPACE = '00000000-0000-4000-8000-0000000000a1';
const MEM = '00000000-0000-4000-8000-0000000000b2';
// A JWT-SHAPED placeholder (three dot-separated parts). Not a real token.
const CALLER_JWT = 'offline.placeholder.jwt';

const NAMES = ['lsp_memory_add', 'lsp_memory_search', 'lsp_memory_update', 'lsp_memory_forget', 'lsp_memory_session_load'];
const ARGS: Record<string, Record<string, unknown>> = {
  lsp_memory_add: { type: 'project', scope: 'tenant', body: 'a fact' },
  lsp_memory_search: { query: 'fact' },
  lsp_memory_update: { id: MEM, body: 'new text' },
  lsp_memory_forget: { id: MEM },
  lsp_memory_session_load: { user_prompt: 'hi' },
};
const hdr = (r: Rec, h: string) => Object.entries(r.headers).find(([k]) => k.toLowerCase() === h.toLowerCase())?.[1];

// (1) schema
for (const n of NAMES) {
  const t = memory.tools.find((x) => x.name === n);
  const prop = (t?.inputSchema as { properties?: Record<string, { type?: string; description?: string }>; required?: string[] })
    ?.properties?.tenant_id;
  assert(`${n}: optional tenant_id in schema`,
    !!prop && prop.type === 'string' && !(t?.inputSchema as { required?: string[] }).required?.includes('tenant_id')
      && !!prop.description?.includes('Only a sub-tenant of your own account is allowed.'));
  assert(`${n}: Connect registers the same handler`, allHandlers[n] === memory.handlers[n]);
}

// (2)+(5) with tenant_id, under the Connect request context
await requestContext.run({ bearer: CALLER_JWT }, async () => {
  for (const n of NAMES) {
    calls.length = 0;
    await memory.handlers[n]({ ...ARGS[n], tenant_id: SPACE });
    const r = calls[0];
    assert(`${n}: exactly one request`, calls.length === 1, String(calls.length));
    assert(`${n}: X-Tenant-Id header = tenant_id`, hdr(r, 'x-tenant-id') === SPACE);
    assert(`${n}: caller JWT carried`, hdr(r, 'authorization') === `Bearer ${CALLER_JWT}`);
    assert(`${n}: tenant_id not in body`,
      r.body === undefined || !Object.prototype.hasOwnProperty.call(r.body as object, 'tenant_id'));
    assert(`${n}: url has no tenant_id`, !r.url.includes(SPACE));
  }
  // update/forget still route by id, and update's body keeps its fields
  calls.length = 0;
  await memory.handlers.lsp_memory_update({ id: MEM, body: 'new text', tenant_id: SPACE });
  assert('update: path carries the memory id', calls[0].url.endsWith(`/v1/memories/${MEM}`) && calls[0].method === 'PUT');
  assert('update: body = the edit fields only', JSON.stringify(calls[0].body) === JSON.stringify({ body: 'new text' }));
  calls.length = 0;
  await memory.handlers.lsp_memory_forget({ id: MEM, tenant_id: SPACE });
  assert('forget: DELETE by id, no body', calls[0].method === 'DELETE' && calls[0].body === undefined);

  // (3) no tenant_id → no header
  for (const n of NAMES) {
    calls.length = 0;
    await memory.handlers[n]({ ...ARGS[n] });
    assert(`${n}: no tenant_id → no X-Tenant-Id`, hdr(calls[0], 'x-tenant-id') === undefined);
  }

  // (4) bad tenant_id → plain error, no request
  for (const bad of ['not-a-uuid', 42, `${SPACE}x`]) {
    calls.length = 0;
    let msg = '';
    try {
      await memory.handlers.lsp_memory_add({ ...ARGS.lsp_memory_add, tenant_id: bad });
    } catch (err) {
      msg = err instanceof Error ? err.message : String(err);
    }
    assert(`bad tenant_id ${JSON.stringify(bad)} → plain error, no request`,
      msg === 'tenant_id must be a tenant id (a uuid).' && calls.length === 0, msg);
  }
});

// (6) API-key sign-in (stdio personal mode, outside the Connect context)
calls.length = 0;
let keyMsg = '';
try {
  await memory.handlers.lsp_memory_add({ ...ARGS.lsp_memory_add, tenant_id: SPACE });
} catch (err) {
  keyMsg = err instanceof Error ? err.message : String(err);
}
assert('API-key sign-in + tenant_id → refused, no request',
  keyMsg.includes('needs a Trust sign-in') && calls.length === 0, keyMsg);
calls.length = 0;
await memory.handlers.lsp_memory_add({ ...ARGS.lsp_memory_add });
assert('API-key sign-in without tenant_id → unchanged', calls.length === 1 && hdr(calls[0], 'x-tenant-id') === undefined);

console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAILED`} — 0 network.`);
process.exit(failed === 0 ? 0 : 1);
