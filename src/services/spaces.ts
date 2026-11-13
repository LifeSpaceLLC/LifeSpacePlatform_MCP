// -- ClaudeCode 2026-11-12 03:14 PM PST: Spaces MCP tools. Thin wrappers — every
// tool is ONE HTTP call to the Spaces service; no rule, filtering or judgement
// lives here, the service enforces everything (scope, allow/block, top-only).
// Real routes (verified against Spaces/src/routes/*.ts, all under /v1):
//   GET   /v1/settings/:tenantId            — all settings for a tenant
//   GET   /v1/settings/:tenantId/:key       — one setting
//   PUT   /v1/settings/:tenantId            — body {key, value} (upsert)
//   GET   /v1/connections?tenantId=         — connections at that level
//   POST  /v1/connections                   — attach a connection
//   PATCH /v1/connections/:id               — label/access/status, move (tenant_id)
//   GET   /v1/spaces/:spaceTenantId/connections — what a Space may use
//   PUT   /v1/spaces/:spaceTenantId/allow/:connectionId — body {mode}
//   GET   /v1/placements?scope=&spaces=     — scope-enforcing read
//   POST  /v1/placements                    — funnel write (top tenant)
//   GET   /v1/sender-rules?tenantId=&spaceTenantId= · POST · PATCH /:id
//   GET   /v1/world?tenantId= · POST · PATCH /:id
//   GET   /v1/holds?tenantId= · POST · POST /:id/answer
// -- ClaudeCode 2026-11-12 (dashboard parity): every action the Spaces dashboard
// offers has a tool here on the SAME route, with the same refusals:
//   GET   /v1/me                            — who am I, my Spaces
//   GET   /v1/overview?scope=all|one&spaces= — the dashboard's right side, scoped
//   GET   /v1/connections/:id/spaces        — who is allowed / blocked / not listed
//   PUT   /v1/spaces/:space/connections/:conn/wants — what that Space should get
//   POST  /v1/connections/connect           — new mailbox connection + sign-in address
//   POST  /v1/connections/:id/connect/start — sign-in address for an existing one
//   POST  /v1/connections/:id/connect/finish — refresh and return its card
//   GET   /v1/connections/:id/status        — connected or not (no outside call)
//   PUT   /v1/reads                         — save the written read for a scope
//   GET   /v1/placements gains since / before / limit
import type { ToolDef, ToolHandler } from '../types.js';
import { call, okText, errText } from '../client.js';

const UUID = { type: 'string', description: 'Tenant uuid.' } as const;
const UUIDS = { type: 'array', items: { type: 'string' }, description: 'Space tenant uuids.' } as const;

// -- ClaudeCode 2026-11-12: the body/query fields each tool forwards, exactly the
// names the route reads. Anything else is rejected loudly (the MCP server does
// not validate args against inputSchema — same guard as lsp_skills_write).
const FIELDS: Record<string, string[]> = {
  lsp_spaces_settings_get: ['tenant_id', 'key'],
  lsp_spaces_settings_set: ['tenant_id', 'key', 'value'],
  lsp_spaces_connections_list: ['tenant_id'],
  lsp_spaces_connection_add: ['tenant_id', 'kind', 'service', 'ref', 'label', 'access', 'status'],
  lsp_spaces_connection_update: ['id', 'tenant_id', 'label', 'access', 'status'],
  lsp_spaces_space_connections: ['space_tenant_id'],
  lsp_spaces_allow_set: ['space_tenant_id', 'connection_id', 'mode'],
  lsp_spaces_placements_list: ['scope', 'spaces', 'since', 'before', 'limit'],
  lsp_spaces_placement_add: [
    'tenant_id', 'connection_id', 'item_id', 'sender', 'subject', 'reason',
    'item_date', 'space_tenant_ids', 'step', 'run_id', 'detail_expires_at',
  ],
  lsp_spaces_sender_rules_list: ['tenant_id', 'space_tenant_id'],
  lsp_spaces_sender_rules_add: ['tenant_id', 'space_tenant_id', 'kind', 'value', 'mode', 'state'],
  lsp_spaces_sender_rules_update: ['id', 'mode', 'state', 'hits'],
  lsp_spaces_world_list: ['tenant_id'],
  lsp_spaces_world_add: ['tenant_id', 'kind', 'name', 'identifiers', 'space_tenant_ids', 'note'],
  lsp_spaces_world_update: ['id', 'space_tenant_ids', 'note'],
  lsp_spaces_holds_list: ['tenant_id'],
  lsp_spaces_holds_add: ['tenant_id', 'placement_id', 'question'],
  lsp_spaces_holds_answer: ['id', 'answer'],
  // -- ClaudeCode 2026-11-12 (dashboard parity):
  lsp_spaces_me: [],
  lsp_spaces_overview: ['scope', 'space'],
  lsp_spaces_connection_spaces: ['connection_id'],
  lsp_spaces_connection_wants_set: ['space_tenant_id', 'connection_id', 'text'],
  lsp_spaces_connect: ['tenant_id', 'label', 'return_to'],
  lsp_spaces_connect_start: ['connection_id', 'return_to'],
  lsp_spaces_connect_finish: ['connection_id'],
  lsp_spaces_connect_status: ['connection_id'],
  lsp_spaces_read_put: ['tenant_id', 'scope', 'text', 'run_id'],
};

export const tools: ToolDef[] = [
  {
    name: 'lsp_spaces_settings_get',
    description:
      "Read Spaces settings for a tenant (the customer's top tenant or one Space). The key appearance holds a Space's picture. Returns every setting row {key, value, version}, or one row when key is given. Customer-level settings live on the top tenant; Space-level ones on the Space.",
    inputSchema: {
      type: 'object',
      properties: {
        tenant_id: UUID,
        key: { type: 'string', description: 'Optional: one setting key (e.g. wants, brief, delivery). Omit for all.' },
      },
      required: ['tenant_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'lsp_spaces_settings_set',
    description:
      "Set one Spaces setting (creates it or bumps its version). Returns the saved row. On a Space, a seat on that Space may set only wants, relevance, brief and labels; every other key is the customer's (top tenant) and a Space seat is refused.",
    inputSchema: {
      type: 'object',
      properties: {
        tenant_id: UUID,
        key: { type: 'string', description: 'Setting key, e.g. brief.' },
        value: { type: 'object', description: 'Setting value (JSON object), e.g. {"text":"ZZ-FIXTURE brief"}.' },
      },
      required: ['tenant_id', 'key', 'value'],
      additionalProperties: false,
    },
  },
  {
    name: 'lsp_spaces_connections_list',
    description:
      'List the connections sitting at one level (the top tenant or a Space). Returns {tenant_id, connections:[{id, kind, service, ref, label, access, status}]}. For what a Space may actually use, call lsp_spaces_space_connections.',
    inputSchema: {
      type: 'object',
      properties: { tenant_id: UUID },
      required: ['tenant_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'lsp_spaces_connection_add',
    description:
      'Attach a connection (a mailbox, calendar, drive…) at a level. On the top tenant it is shared and each Space must be allowed to use it; on a Space it belongs to that Space only. Returns the new row. access defaults to read; status defaults to active.',
    inputSchema: {
      type: 'object',
      properties: {
        tenant_id: UUID,
        kind: { type: 'string', description: 'Connection kind, e.g. mailbox.' },
        service: { type: 'string', description: 'Backing service, e.g. listen.' },
        ref: { type: 'string', description: 'Optional id of the source in its service.' },
        label: { type: 'string', description: 'Optional plain label, e.g. "ZZ-FIXTURE inbox".' },
        access: { type: 'string', enum: ['read', 'read_write'] },
        status: { type: 'string', enum: ['active', 'paused', 'disabled', 'error'] },
      },
      required: ['tenant_id', 'kind', 'service'],
      additionalProperties: false,
    },
  },
  {
    name: 'lsp_spaces_connection_update',
    description:
      "Change a connection's label, access or status, or move it to another level of the same customer (pass tenant_id). A move resets that connection's allow list. For access, status and a move: Only the customer (the top tenant) may change this; a seat on a Space is refused.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Connection uuid.' },
        tenant_id: { type: 'string', description: 'Optional: move to this level (top tenant or a Space of the same customer).' },
        label: { type: 'string' },
        access: { type: 'string', enum: ['read', 'read_write'] },
        status: { type: 'string', enum: ['active', 'paused', 'disabled', 'error'] },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'lsp_spaces_space_connections',
    description:
      "List the connections one Space may use: its own plus the top tenant's shared ones it is allowed. Each row carries origin = own | shared. A blocked or unlisted shared connection, and a sibling Space's own connection, are never returned.",
    inputSchema: {
      type: 'object',
      properties: { space_tenant_id: { type: 'string', description: 'Space tenant uuid.' } },
      required: ['space_tenant_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'lsp_spaces_allow_set',
    description:
      "Allow or block one Space from using a shared connection on the top tenant. Returns {space_tenant_id, connection_id, mode}. Only the customer (the top tenant) may change this; a seat on a Space is refused.",
    inputSchema: {
      type: 'object',
      properties: {
        space_tenant_id: { type: 'string', description: 'Space tenant uuid.' },
        connection_id: { type: 'string', description: 'Shared connection uuid (sits on the top tenant).' },
        mode: { type: 'string', enum: ['allow', 'block'] },
      },
      required: ['space_tenant_id', 'connection_id', 'mode'],
      additionalProperties: false,
    },
  },
  {
    name: 'lsp_spaces_placements_list',
    description:
      "Read where items were placed. Every question has a scope. Pass `scope` = `all`, `one` or `some` and the Space ids. The service returns only what the caller may see in that scope; never widen a scope to be helpful. Returns {scope, spaces_drawn_from, includes_held, count, placements, next_before}; each placement says which connection it came from and when it was placed. Newest first, 50 per page by default.",
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['all', 'one', 'some'] },
        spaces: { ...UUIDS, description: 'Space tenant uuids for scope one/some.' },
        since: { type: 'string', description: 'Optional ISO time: only items placed at or after it.' },
        before: { type: 'string', description: 'Optional ISO time cursor: pass the previous next_before to get the next page.' },
        limit: { type: 'number', description: 'Optional page size, 1 to 200 (default 50). Newest first.' },
      },
      required: ['scope'],
      additionalProperties: false,
    },
  },
  {
    name: 'lsp_spaces_placement_add',
    description:
      "Log one placement at the customer's top tenant (the funnel's write). Empty space_tenant_ids = held for the customer. Every named Space must be this customer's and allowed to use the connection. Returns {id, item_id, space_tenant_ids, held, step}.",
    inputSchema: {
      type: 'object',
      properties: {
        tenant_id: { type: 'string', description: 'Top tenant uuid.' },
        connection_id: { type: 'string', description: 'Connection uuid the item came through.' },
        item_id: { type: 'string', description: 'Id of the item in its source, e.g. ZZ-FIXTURE-msg-1.' },
        sender: { type: 'string', description: 'Optional sender address (stored encrypted).' },
        subject: { type: 'string', description: 'Optional subject (stored encrypted).' },
        reason: { type: 'string', description: 'Optional reason for the placement (stored encrypted).' },
        item_date: { type: 'string', description: 'Optional ISO date of the item.' },
        space_tenant_ids: UUIDS,
        step: { type: 'string', description: 'Optional funnel step that placed it.' },
        run_id: { type: 'string', description: 'Optional run uuid.' },
        detail_expires_at: { type: 'string', description: 'Optional ISO date the detail expires.' },
      },
      required: ['tenant_id', 'connection_id', 'item_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'lsp_spaces_sender_rules_list',
    description:
      "List sender rules (address or domain → goes_here | never_here | noise). Returns {tenant_id, sender_rules}. A Space sees only its own rules; the top tenant may filter by space_tenant_id.",
    inputSchema: {
      type: 'object',
      properties: {
        tenant_id: UUID,
        space_tenant_id: { type: 'string', description: 'Optional Space filter (top tenant caller).' },
      },
      required: ['tenant_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'lsp_spaces_sender_rules_add',
    description:
      "Add a sender rule. kind = address | domain; mode = goes_here | never_here | noise; no space_tenant_id on the top tenant = the customer's noise list. Only the customer (the top tenant) may approve a rule; a seat on a Space may only propose rules for its own Space. Returns the new rule.",
    inputSchema: {
      type: 'object',
      properties: {
        tenant_id: UUID,
        space_tenant_id: { type: 'string', description: 'Optional Space the rule is for.' },
        kind: { type: 'string', enum: ['address', 'domain'] },
        value: { type: 'string', description: 'Address or domain, e.g. zz-fixture.example.' },
        mode: { type: 'string', enum: ['goes_here', 'never_here', 'noise'] },
        state: { type: 'string', enum: ['proposed', 'approved'] },
      },
      required: ['tenant_id', 'kind', 'value', 'mode'],
      additionalProperties: false,
    },
  },
  {
    name: 'lsp_spaces_sender_rules_update',
    description:
      "Change a sender rule's mode, state or hits. Only the customer (the top tenant) may approve a rule. Returns the updated rule.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Sender rule uuid.' },
        mode: { type: 'string', enum: ['goes_here', 'never_here', 'noise'] },
        state: { type: 'string', enum: ['proposed', 'approved'] },
        hits: { type: 'number', description: 'Integer hit count.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'lsp_spaces_world_list',
    description:
      "List the people and organisations in the customer's world. The world lives at the top tenant only. Returns {tenant_id, world:[{id, kind, name, identifiers, space_tenant_ids, note}]}.",
    inputSchema: {
      type: 'object',
      properties: { tenant_id: { type: 'string', description: 'Top tenant uuid.' } },
      required: ['tenant_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'lsp_spaces_world_add',
    description:
      "Add a person or organisation to the customer's world (top tenant only). Named Spaces must be this customer's. Returns {id, kind, space_tenant_ids}.",
    inputSchema: {
      type: 'object',
      properties: {
        tenant_id: { type: 'string', description: 'Top tenant uuid.' },
        kind: { type: 'string', enum: ['person', 'organisation'] },
        name: { type: 'string', description: 'e.g. "ZZ-FIXTURE Org".' },
        identifiers: { type: 'object', description: 'Addresses and domains, e.g. {"domains":["zz-fixture.example"]}.' },
        space_tenant_ids: UUIDS,
        note: { type: 'string' },
      },
      required: ['tenant_id', 'kind', 'name'],
      additionalProperties: false,
    },
  },
  {
    name: 'lsp_spaces_world_update',
    description:
      "Correct a world entry: change its Spaces or note (stamps corrected_at). Named Spaces must be this customer's. Returns {id, kind, space_tenant_ids, corrected_at}.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'World entry uuid.' },
        space_tenant_ids: UUIDS,
        note: { type: 'string' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'lsp_spaces_holds_list',
    description:
      "List held items and the one question asked about each. Holds live at the top tenant and are the customer's only. Returns {tenant_id, holds:[{id, placement_id, question, answer, answered_at}]}.",
    inputSchema: {
      type: 'object',
      properties: { tenant_id: { type: 'string', description: 'Top tenant uuid.' } },
      required: ['tenant_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'lsp_spaces_holds_add',
    description:
      "Record a hold: a held placement of this customer plus one short question. Top tenant only. Returns {id, tenant_id, placement_id}.",
    inputSchema: {
      type: 'object',
      properties: {
        tenant_id: { type: 'string', description: 'Top tenant uuid.' },
        placement_id: { type: 'string', description: 'Held placement uuid.' },
        question: { type: 'string', description: 'e.g. "Which Space does ZZ-FIXTURE belong in?"' },
      },
      required: ['tenant_id', 'placement_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'lsp_spaces_holds_answer',
    description:
      "Answer a hold. The answer is kept with a date and the item is placed on the next run. Returns {id, placement_id, answered_at}.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Hold uuid.' },
        answer: { type: 'string' },
      },
      required: ['id', 'answer'],
      additionalProperties: false,
    },
  },
  // -- ClaudeCode 2026-11-12 (dashboard parity): the tools below do what the
  // Spaces dashboard does, through the same routes.
  {
    name: 'lsp_spaces_me',
    description:
      "Who am I in Spaces. Returns {kind: customer | space | none, customer, is_customer, spaces:[{id, name, picture, counts:{connections, placed}}], can:{connect}}. The customer sees all its Spaces; a seat on one Space sees that Space only. Start here to get the Space ids and names.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'lsp_spaces_overview',
    description:
      "The Spaces dashboard in one read: a short written read, counts, the connections with their plain status, items waiting for an answer, and where recent items went. Every question has a scope. Pass `scope` = `all` for the rollup or `one` with one Space id. The service returns only what the caller may see in that scope; never widen a scope to be helpful.",
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['all', 'one'] },
        space: { type: 'string', description: 'The one Space tenant uuid, for scope one.' },
      },
      required: ['scope'],
      additionalProperties: false,
    },
  },
  {
    name: 'lsp_spaces_connection_spaces',
    description:
      "For one connection: each Space as allowed, blocked or not_listed, with the text saying what that Space should get from it. The customer sees every Space; a seat on a Space sees only its own row. Returns {connection_id, level: shared | this_space_only, spaces:[{id, name, state, wants}]}.",
    inputSchema: {
      type: 'object',
      properties: { connection_id: { type: 'string', description: 'Connection uuid.' } },
      required: ['connection_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'lsp_spaces_connection_wants_set',
    description:
      "Write, in plain words, what one Space should get from one connection (for example \"ZZ-FIXTURE school notices and anything from the coach\"). The customer may write it for any of its Spaces; a seat on a Space for its own Space only. It never allows anything: a blocked Space stays blocked. An empty text removes it. Returns {space_tenant_id, connection_id, wants, updated_at}.",
    inputSchema: {
      type: 'object',
      properties: {
        space_tenant_id: { type: 'string', description: 'Space tenant uuid.' },
        connection_id: { type: 'string', description: 'Connection uuid (shared, or that Space\'s own).' },
        text: { type: 'string', description: 'Plain words, at most 2000 characters. Empty to remove.' },
      },
      required: ['space_tenant_id', 'connection_id', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'lsp_spaces_connect',
    description:
      "Connect a new mailbox. tenant_id = the customer's top tenant makes it shared; a Space's id makes it that Space only. Returns {connection, sign_in_url}. The person must open sign_in_url themselves and sign in at Google: give them the address; never open a browser. Afterwards call lsp_spaces_connect_finish. Only an admin sign-in that is the customer may connect; anyone else is refused.",
    inputSchema: {
      type: 'object',
      properties: {
        tenant_id: { type: 'string', description: 'Top tenant uuid (shared) or a Space uuid (that Space only).' },
        label: { type: 'string', description: 'Optional plain name for the card, e.g. "ZZ-FIXTURE family mail".' },
        return_to: { type: 'string', description: 'Optional page the person lands on after signing in; must be a Spaces dashboard address.' },
      },
      required: ['tenant_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'lsp_spaces_connect_start',
    description:
      "Get the sign-in address for a connection that already exists but is not connected yet. Creates nothing. Returns {connection_id, sign_in_url}. The person must open it themselves; never open a browser. Afterwards call lsp_spaces_connect_finish. Only an admin sign-in that is the customer may connect.",
    inputSchema: {
      type: 'object',
      properties: {
        connection_id: { type: 'string', description: 'Connection uuid.' },
        return_to: { type: 'string', description: 'Optional page the person lands on after signing in; must be a Spaces dashboard address.' },
      },
      required: ['connection_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'lsp_spaces_connect_finish',
    description:
      "After the person has signed in at Google: check the connection and save its status. Returns the connection's card {connected, address, last_mail_at, …}. If connected is still false the sign-in did not complete. Only an admin sign-in that is the customer may call this.",
    inputSchema: {
      type: 'object',
      properties: { connection_id: { type: 'string', description: 'Connection uuid.' } },
      required: ['connection_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'lsp_spaces_connect_status',
    description:
      "Is this connection connected? Returns {connection_id, status, connected, address, last_mail_at, last_checked_at, refreshed_at} as last saved. Visible to the customer and to a Space that may use the connection.",
    inputSchema: {
      type: 'object',
      properties: { connection_id: { type: 'string', description: 'Connection uuid.' } },
      required: ['connection_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'lsp_spaces_read_put',
    description:
      "Save the short written read the dashboard shows for one scope: scope = all for the rollup, or one Space id. Only the customer (the top tenant) may save a read; a seat on a Space is refused. Write it only from items in that scope. Returns {scope, written_at}.",
    inputSchema: {
      type: 'object',
      properties: {
        tenant_id: { type: 'string', description: 'Top tenant uuid.' },
        scope: { type: 'string', description: '"all" or one Space tenant uuid of this customer.' },
        text: { type: 'string', description: 'Two to four plain sentences, at most 1500 characters.' },
        run_id: { type: 'string', description: 'Optional run uuid.' },
      },
      required: ['tenant_id', 'scope', 'text'],
      additionalProperties: false,
    },
  },
];

type Args = Record<string, unknown>;

// -- ClaudeCode 2026-11-12: input-shape guards only (no business rules). Reject
// unknown props; require the path ids so a call never hits ".../undefined".
function checked(tool: string, raw: unknown, pathIds: string[]): Args | Error {
  const args = (raw ?? {}) as Args;
  const allowed = new Set(FIELDS[tool]);
  const unknown = Object.keys(args).filter((k) => !allowed.has(k));
  if (unknown.length) {
    return new Error(`Unknown propert${unknown.length > 1 ? 'ies' : 'y'} for ${tool}: ${unknown.join(', ')}`);
  }
  for (const k of pathIds) {
    if (typeof args[k] !== 'string' || !(args[k] as string).trim()) return new Error(`${k} is required (string).`);
  }
  return args;
}

function body(args: Args, keys: string[]): Args {
  const out: Args = {};
  for (const k of keys) if (args[k] !== undefined) out[k] = args[k];
  return out;
}

function qs(pairs: Record<string, unknown>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(pairs)) if (typeof v === 'string' && v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
}

const enc = (v: unknown) => encodeURIComponent(String(v));

type Run = (a: Args) => Promise<unknown>;

function handler(tool: string, pathIds: string[], run: Run): ToolHandler {
  return async (raw) => {
    const a = checked(tool, raw, pathIds);
    if (a instanceof Error) return errText(a);
    return okText(await run(a));
  };
}

export const handlers: Record<string, ToolHandler> = {
  lsp_spaces_settings_get: handler('lsp_spaces_settings_get', ['tenant_id'], (a) =>
    call('spaces', `/v1/settings/${enc(a.tenant_id)}${a.key ? `/${enc(a.key)}` : ''}`, 'GET')),
  lsp_spaces_settings_set: handler('lsp_spaces_settings_set', ['tenant_id'], (a) =>
    call('spaces', `/v1/settings/${enc(a.tenant_id)}`, 'PUT', body(a, ['key', 'value']))),
  lsp_spaces_connections_list: handler('lsp_spaces_connections_list', ['tenant_id'], (a) =>
    call('spaces', `/v1/connections${qs({ tenantId: a.tenant_id })}`, 'GET')),
  lsp_spaces_connection_add: handler('lsp_spaces_connection_add', [], (a) =>
    call('spaces', '/v1/connections', 'POST', body(a, FIELDS.lsp_spaces_connection_add))),
  lsp_spaces_connection_update: handler('lsp_spaces_connection_update', ['id'], (a) =>
    call('spaces', `/v1/connections/${enc(a.id)}`, 'PATCH', body(a, ['tenant_id', 'label', 'access', 'status']))),
  lsp_spaces_space_connections: handler('lsp_spaces_space_connections', ['space_tenant_id'], (a) =>
    call('spaces', `/v1/spaces/${enc(a.space_tenant_id)}/connections`, 'GET')),
  lsp_spaces_allow_set: handler('lsp_spaces_allow_set', ['space_tenant_id', 'connection_id'], (a) =>
    call('spaces', `/v1/spaces/${enc(a.space_tenant_id)}/allow/${enc(a.connection_id)}`, 'PUT', body(a, ['mode']))),
  lsp_spaces_placements_list: handler('lsp_spaces_placements_list', [], (a) =>
    call('spaces', `/v1/placements${qs({
      scope: a.scope,
      spaces: Array.isArray(a.spaces) ? a.spaces.join(',') : a.spaces,
      since: a.since,
      before: a.before,
      limit: typeof a.limit === 'number' ? String(a.limit) : a.limit,
    })}`, 'GET')),
  lsp_spaces_placement_add: handler('lsp_spaces_placement_add', [], (a) =>
    call('spaces', '/v1/placements', 'POST', body(a, FIELDS.lsp_spaces_placement_add))),
  lsp_spaces_sender_rules_list: handler('lsp_spaces_sender_rules_list', ['tenant_id'], (a) =>
    call('spaces', `/v1/sender-rules${qs({ tenantId: a.tenant_id, spaceTenantId: a.space_tenant_id })}`, 'GET')),
  lsp_spaces_sender_rules_add: handler('lsp_spaces_sender_rules_add', [], (a) =>
    call('spaces', '/v1/sender-rules', 'POST', body(a, FIELDS.lsp_spaces_sender_rules_add))),
  lsp_spaces_sender_rules_update: handler('lsp_spaces_sender_rules_update', ['id'], (a) =>
    call('spaces', `/v1/sender-rules/${enc(a.id)}`, 'PATCH', body(a, ['mode', 'state', 'hits']))),
  lsp_spaces_world_list: handler('lsp_spaces_world_list', ['tenant_id'], (a) =>
    call('spaces', `/v1/world${qs({ tenantId: a.tenant_id })}`, 'GET')),
  lsp_spaces_world_add: handler('lsp_spaces_world_add', [], (a) =>
    call('spaces', '/v1/world', 'POST', body(a, FIELDS.lsp_spaces_world_add))),
  lsp_spaces_world_update: handler('lsp_spaces_world_update', ['id'], (a) =>
    call('spaces', `/v1/world/${enc(a.id)}`, 'PATCH', body(a, ['space_tenant_ids', 'note']))),
  lsp_spaces_holds_list: handler('lsp_spaces_holds_list', ['tenant_id'], (a) =>
    call('spaces', `/v1/holds${qs({ tenantId: a.tenant_id })}`, 'GET')),
  lsp_spaces_holds_add: handler('lsp_spaces_holds_add', [], (a) =>
    call('spaces', '/v1/holds', 'POST', body(a, FIELDS.lsp_spaces_holds_add))),
  lsp_spaces_holds_answer: handler('lsp_spaces_holds_answer', ['id'], (a) =>
    call('spaces', `/v1/holds/${enc(a.id)}/answer`, 'POST', body(a, ['answer']))),
  // -- ClaudeCode 2026-11-12 (dashboard parity):
  lsp_spaces_me: handler('lsp_spaces_me', [], () => call('spaces', '/v1/me', 'GET')),
  lsp_spaces_overview: handler('lsp_spaces_overview', [], (a) =>
    call('spaces', `/v1/overview${qs({ scope: a.scope, spaces: a.space })}`, 'GET')),
  lsp_spaces_connection_spaces: handler('lsp_spaces_connection_spaces', ['connection_id'], (a) =>
    call('spaces', `/v1/connections/${enc(a.connection_id)}/spaces`, 'GET')),
  lsp_spaces_connection_wants_set: handler('lsp_spaces_connection_wants_set', ['space_tenant_id', 'connection_id'], (a) =>
    call('spaces', `/v1/spaces/${enc(a.space_tenant_id)}/connections/${enc(a.connection_id)}/wants`, 'PUT', body(a, ['text']))),
  lsp_spaces_connect: handler('lsp_spaces_connect', ['tenant_id'], (a) =>
    call('spaces', '/v1/connections/connect', 'POST', { ...body(a, ['tenant_id', 'label', 'return_to']), kind: 'mail' })),
  lsp_spaces_connect_start: handler('lsp_spaces_connect_start', ['connection_id'], (a) =>
    call('spaces', `/v1/connections/${enc(a.connection_id)}/connect/start`, 'POST', body(a, ['return_to']))),
  lsp_spaces_connect_finish: handler('lsp_spaces_connect_finish', ['connection_id'], (a) =>
    call('spaces', `/v1/connections/${enc(a.connection_id)}/connect/finish`, 'POST', {})),
  lsp_spaces_connect_status: handler('lsp_spaces_connect_status', ['connection_id'], (a) =>
    call('spaces', `/v1/connections/${enc(a.connection_id)}/status`, 'GET')),
  lsp_spaces_read_put: handler('lsp_spaces_read_put', ['tenant_id'], (a) =>
    call('spaces', '/v1/reads', 'PUT', body(a, FIELDS.lsp_spaces_read_put))),
};
