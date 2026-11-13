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
// -- ClaudeCode 2026-11-13 (problems):
//   GET   /v1/problems?scope=all|one&spaces= — plain-sentence problems, scoped
//   POST  /v1/connections/refresh           — refresh on open, owner admin sign-in only
// -- ClaudeCode 2026-11-13 (add a Space): 12:20 PM PDT
//   POST  /v1/spaces                        — add a Space (owner admin sign-in only)
//   PATCH /v1/spaces/:id                    — rename a Space (name only)
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
  lsp_spaces_placements_list: ['scope', 'spaces', 'topic', 'since', 'before', 'limit'],
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
  lsp_spaces_overview: ['scope', 'space', 'topic'],
  lsp_spaces_connection_spaces: ['connection_id'],
  lsp_spaces_connection_wants_set: ['space_tenant_id', 'connection_id', 'text'],
  lsp_spaces_connect: ['tenant_id', 'label', 'return_to'],
  lsp_spaces_connect_start: ['connection_id', 'return_to'],
  lsp_spaces_connect_finish: ['connection_id'],
  lsp_spaces_connect_status: ['connection_id'],
  lsp_spaces_read_put: ['tenant_id', 'scope', 'text', 'run_id'],
  // -- ClaudeCode 2026-11-13 (problems):
  lsp_spaces_problems: ['scope', 'space', 'topic'],
  lsp_spaces_refresh: ['scope', 'space'],
  // -- ClaudeCode 2026-11-13 (add a Space):
  lsp_spaces_space_add: ['name'],
  lsp_spaces_space_rename: ['space_id', 'name'],
  // -- ClaudeCode 2026-11-13 (topics):
  lsp_spaces_topics_list: ['space_id'],
  lsp_spaces_topic_add: ['space_id', 'name', 'wants', 'connection_ids'],
  lsp_spaces_topic_update: ['topic_id', 'name', 'wants', 'connection_ids', 'position'],
  lsp_spaces_topic_remove: ['topic_id'],
  // -- ClaudeCode 2026-11-13 12:53 PM PDT (sorter):
  lsp_spaces_sorting_start: ['connection_id'],
  lsp_spaces_sorting_stop: ['connection_id'],
  lsp_spaces_runs_list: ['connection_id', 'limit'],
  lsp_spaces_runs_compare: ['run_id', 'other_run_id'],
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
      "Read where items were placed. Every question has a scope. Pass `scope` = `all`, `one` or `some` and the Space ids. The service returns only what the caller may see in that scope; never widen a scope to be helpful. Each placement says which connection it came from and when it was placed. THE ANSWER IS ONE PAGE, NOT THE WHOLE LOG: newest first, 50 rows by default (limit 1 to 200). Returns {scope, spaces_drawn_from, includes_held, count, total, has_more, next_before, placements}: `count` = rows on this page, `total` = rows in the caller's scope, `has_more` = older rows exist. To get the rest, call again with `before` = the `next_before` you were given, unchanged, until `has_more` is false. Never report a page as the full list: say how many of `total` you read.",
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['all', 'one', 'some', 'topic'] },
        spaces: { ...UUIDS, description: 'Space tenant uuids for scope one/some.' },
        topic: { type: 'string', description: 'The topic uuid, for scope topic (from lsp_spaces_topics_list or lsp_spaces_me). Narrows to that topic only.' },
        since: { type: 'string', description: 'Optional ISO time: only items placed at or after it.' },
        before: { type: 'string', description: 'Optional paging cursor: pass the previous answer\'s next_before, unchanged, to get the next (older) page. A plain ISO time also works: only items placed before it.' },
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
      "The Spaces dashboard in one read: a short written read, counts, the connections with their plain status, items waiting for an answer, and where recent items went. Its `placements` list is only the newest page: `placements_page` {count, total, has_more, next_before} says how much more exists; read the rest with lsp_spaces_placements_list. For the customer, a one-Space answer also lists EVERY shared connection with that Space's own state on it (allowed, blocked or not listed); for a seat on a Space, only the connections it may use now. Each connection carries refreshed_at and stale: a stale connection is shown as \"Not checked since <time>\", never as connected. Every question has a scope. Pass `scope` = `all` for the rollup, `one` with one Space id, or `topic` with one topic id (the same dashboard narrowed to that topic: its connections and the items tagged with it; a topic only ever narrows its Space). The service returns only what the caller may see in that scope; never widen a scope to be helpful.",
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['all', 'one', 'topic'] },
        space: { type: 'string', description: 'The one Space tenant uuid, for scope one.' },
        topic: { type: 'string', description: 'The topic uuid, for scope topic (from lsp_spaces_topics_list or lsp_spaces_me). Narrows to that topic only.' },
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
  // -- ClaudeCode 2026-11-13 (problems): the problems view and refresh on open.
  {
    name: 'lsp_spaces_problems',
    description:
      "The customer's own problems view: what is wrong with its connections, one plain sentence each (for example \"Family stopped working. Connect it again.\"). Scoped like every other read: pass `scope` = `all` for the rollup or `one` with one Space id; the service returns only what the caller may see in that scope; never widen a scope to be helpful. Returns {scope, spaces_drawn_from, count, problems:[{key, kind: stopped | check_failed | not_checked | paused | not_connected, connection:{id, name, level}, spaces, since, text, action: connect | null}], stale_after_minutes}. Show the text as it is. To act: connecting again is a person's own action, through the Spaces screen or lsp_spaces_connect_start (the person opens the address themselves); only the account owner's admin sign-in may connect.",
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['all', 'one', 'topic'] },
        space: { type: 'string', description: 'The one Space tenant uuid, for scope one.' },
        topic: { type: 'string', description: 'The topic uuid, for scope topic (from lsp_spaces_topics_list or lsp_spaces_me). Narrows to that topic only.' },
      },
      required: ['scope'],
      additionalProperties: false,
    },
  },
  {
    name: 'lsp_spaces_refresh',
    description:
      "Refresh the saved status of the connections in a scope, under the caller's own sign-in (Spaces holds no credential of its own). It works only for the account owner's admin sign-in; every other caller, and any connection refreshed in the last 2 minutes, is skipped with a reason, and one failure never fails the call. Pass `scope` = `all` or `one` with one Space id; never widen a scope to be helpful. Returns {refreshed:[id], skipped:[{id, reason: not_allowed | recent | not_listen}], failed:[id], refreshed_at}.",
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
  // -- ClaudeCode 2026-11-13 (add a Space): add and rename a Space.
  {
    name: 'lsp_spaces_space_add',
    description:
      "Add a Space under the caller's customer. Works only for the account owner's admin sign-in; anyone else is refused with \"Ask the account owner to add a Space.\" A Space is a wall, not a folder: add one only when the owner wants things kept apart from the rest (for example one person's mail kept separate), never just to sort or group things — people, topics and kinds of mail inside one area belong in one Space. Ask the owner before adding. The name is one line, 1 to 80 characters. Returns the new Space as it shows in the list: {id, name, picture, counts:{connections, placed}}. There is no tool to delete a Space; never try to remove one.",
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The Space name: one line, 1 to 80 characters.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'lsp_spaces_space_rename',
    description:
      "Rename one Space of the caller's customer (the name only; nothing else about the Space changes). Works only for the account owner's admin sign-in; anyone else is refused with \"Ask the account owner to add a Space.\" A Space of another customer is not found. The name is one line, 1 to 80 characters. Returns {id, name}. A Space is a wall, not a folder; never delete one.",
    inputSchema: {
      type: 'object',
      properties: {
        space_id: { type: 'string', description: 'The Space tenant uuid.' },
        name: { type: 'string', description: 'The new name: one line, 1 to 80 characters.' },
      },
      required: ['space_id', 'name'],
      additionalProperties: false,
    },
  },
  // -- ClaudeCode 2026-11-13 (topics): a TOPIC is a light thing inside a Space: a name, one
  // plain "what to look for" text and which connections it draws from. Not a wall.
  {
    name: 'lsp_spaces_topics_list',
    description:
      "List the topics of one Space. A topic is a name plus one plain text saying what to look for, inside a Space; it draws from every connection its Space may use unless narrowed (connection_ids). A topic is NOT a wall: everyone who can see the Space sees its topics. The customer may list any of its Spaces; a seat only its own. Returns {space_tenant_id, topics:[{id, space_tenant_id, name, wants, connection_ids, position, created_at, updated_at, counts:{placed}}]}.",
    inputSchema: {
      type: 'object',
      properties: { space_id: { type: 'string', description: 'The Space tenant uuid.' } },
      required: ['space_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'lsp_spaces_topic_add',
    description:
      "Add a topic to a Space, so items about one thing are tagged with it and can be looked at on their own. Use a topic, not a new Space, for one subject inside an area (a new Space is a wall and is the owner's call). The customer may add to any of its Spaces; a seat to its own Space. `name`: one line, 1 to 80 characters. `wants`: what to look for, in plain words (optional; until it is set, nothing is tagged with the topic). `connection_ids`: optional; leave it out to draw from every connection the Space may use, or name some of them (each must be usable by that Space now, else 422). Returns the topic.",
    inputSchema: {
      type: 'object',
      properties: {
        space_id: { type: 'string', description: 'The Space tenant uuid.' },
        name: { type: 'string', description: 'The topic name: one line, 1 to 80 characters.' },
        wants: { type: 'string', description: 'What to look for, in plain words (up to 2000 characters).' },
        connection_ids: { type: 'array', items: { type: 'string' }, description: 'Optional: only these connections (uuids). Leave out for all the Space may use.' },
      },
      required: ['space_id', 'name'],
      additionalProperties: false,
    },
  },
  {
    name: 'lsp_spaces_topic_update',
    description:
      "Change a topic: its name, what to look for, which connections it draws from (null = all the Space may use again), or its position in the list. The customer, or a seat on the topic's Space. Returns the topic.",
    inputSchema: {
      type: 'object',
      properties: {
        topic_id: { type: 'string', description: 'The topic uuid.' },
        name: { type: 'string' },
        wants: { type: ['string', 'null'], description: 'What to look for; null or empty clears it.' },
        connection_ids: { type: ['array', 'null'], items: { type: 'string' }, description: 'Only these connections; null = all the Space may use.' },
        position: { type: 'number' },
      },
      required: ['topic_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'lsp_spaces_topic_remove',
    description:
      "Remove a topic. The account owner only; a seat is refused. The items stay in the Space; only their tag for this topic goes. Ask the owner before removing. Returns {deleted, id}.",
    inputSchema: {
      type: 'object',
      properties: { topic_id: { type: 'string', description: 'The topic uuid.' } },
      required: ['topic_id'],
      additionalProperties: false,
    },
  },
  // -- ClaudeCode 2026-11-13 12:53 PM PDT (sorter): start / stop sorting and the run log.
  // /v1/sort/batch, /v1/sort/judged and /v1/runs/start|finish have NO tool: they are the runner's alone.
  // -- ClaudeCode 2026-11-13 (filter wording): descriptions say filtering / the filter; tool names unchanged.
  {
    name: 'lsp_spaces_sorting_start',
    description:
      "Start filtering one connection. This is the account owner's own action, under their own sign-in; anyone else is refused with \"Ask the account owner to start or stop filtering.\" and nothing is sent on. Start begins reading new mail only from that moment (forward only, nothing earlier is read), and only when a Space wants the connection: a connection no Space is set to get anything from, or one that is not connected yet, is refused. Under the default cache setting, sender, subject and why an item was placed are not kept in the cloud. Returns {connection_id, sorting:{state, started_at, last_run_at, last_run_status}, check_interval_minutes, cache}.",
    inputSchema: {
      type: 'object',
      properties: { connection_id: { type: 'string', description: 'Connection uuid.' } },
      required: ['connection_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'lsp_spaces_sorting_stop',
    description:
      "Stop filtering one connection: stop turns reading off. This is the account owner's own action, under their own sign-in; anyone else is refused with \"Ask the account owner to start or stop filtering.\" and nothing is sent on. Returns {connection_id, sorting}.",
    inputSchema: {
      type: 'object',
      properties: { connection_id: { type: 'string', description: 'Connection uuid.' } },
      required: ['connection_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'lsp_spaces_runs_list',
    description:
      "The run log of one connection, newest first. A run lists counts only (how many items went each way), never the items themselves. The account owner sees every run; a seat on a Space that may use the connection sees the same counts. Under the default cache setting, sender, subject and why an item was placed are not kept in the cloud. Returns {connection_id, count, runs:[{id, mode, status, started_at, finished_at, counts, observed?, note?}]} (observed and note for the owner only). limit 1 to 100, default 20. Running the filter (the /v1/sort/batch, /v1/sort/judged and /v1/runs start and finish routes) belongs to the filter on your computer alone and has no tool here; never try to do it.", // -- ClaudeCode 2026-11-13 (filter wording)
    inputSchema: {
      type: 'object',
      properties: {
        connection_id: { type: 'string', description: 'Connection uuid.' },
        limit: { type: 'number', description: 'Optional number of runs, 1 to 100 (default 20).' },
      },
      required: ['connection_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'lsp_spaces_runs_compare',
    description:
      "Compare two runs of the same connection: which items were placed differently (Spaces or topics). The account owner only. Returns {a, b, items, same, different, differences:[{item_id, a, b}]}: item ids, Spaces, topics and step only.",
    inputSchema: {
      type: 'object',
      properties: {
        run_id: { type: 'string', description: 'The first run uuid.' },
        other_run_id: { type: 'string', description: 'The other run uuid (same connection).' },
      },
      required: ['run_id', 'other_run_id'],
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
      topic: a.topic,
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
    call('spaces', `/v1/overview${qs({ scope: a.scope, spaces: a.space, topic: a.topic })}`, 'GET')),
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
  // -- ClaudeCode 2026-11-13 (problems):
  lsp_spaces_problems: handler('lsp_spaces_problems', [], (a) =>
    call('spaces', `/v1/problems${qs({ scope: a.scope, spaces: a.space, topic: a.topic })}`, 'GET')),
  lsp_spaces_refresh: handler('lsp_spaces_refresh', [], (a) =>
    call('spaces', '/v1/connections/refresh', 'POST', { scope: a.scope, ...(typeof a.space === 'string' && a.space ? { spaces: [a.space] } : {}) })),
  // -- ClaudeCode 2026-11-13 (add a Space):
  lsp_spaces_space_add: handler('lsp_spaces_space_add', [], (a) =>
    call('spaces', '/v1/spaces', 'POST', body(a, ['name']))),
  lsp_spaces_space_rename: handler('lsp_spaces_space_rename', ['space_id'], (a) =>
    call('spaces', `/v1/spaces/${enc(a.space_id)}`, 'PATCH', body(a, ['name']))),
  // -- ClaudeCode 2026-11-13 (topics):
  lsp_spaces_topics_list: handler('lsp_spaces_topics_list', ['space_id'], (a) =>
    call('spaces', `/v1/spaces/${enc(a.space_id)}/topics`, 'GET')),
  lsp_spaces_topic_add: handler('lsp_spaces_topic_add', ['space_id'], (a) =>
    call('spaces', `/v1/spaces/${enc(a.space_id)}/topics`, 'POST', body(a, ['name', 'wants', 'connection_ids']))),
  lsp_spaces_topic_update: handler('lsp_spaces_topic_update', ['topic_id'], (a) =>
    call('spaces', `/v1/topics/${enc(a.topic_id)}`, 'PATCH', body(a, ['name', 'wants', 'connection_ids', 'position']))),
  lsp_spaces_topic_remove: handler('lsp_spaces_topic_remove', ['topic_id'], (a) =>
    call('spaces', `/v1/topics/${enc(a.topic_id)}`, 'DELETE')),
  // -- ClaudeCode 2026-11-13 12:53 PM PDT (sorter):
  lsp_spaces_sorting_start: handler('lsp_spaces_sorting_start', ['connection_id'], (a) =>
    call('spaces', `/v1/connections/${enc(a.connection_id)}/sorting/start`, 'POST', {})),
  lsp_spaces_sorting_stop: handler('lsp_spaces_sorting_stop', ['connection_id'], (a) =>
    call('spaces', `/v1/connections/${enc(a.connection_id)}/sorting/stop`, 'POST', {})),
  lsp_spaces_runs_list: handler('lsp_spaces_runs_list', ['connection_id'], (a) =>
    call('spaces', `/v1/runs${qs({ connection_id: a.connection_id, limit: typeof a.limit === 'number' ? String(a.limit) : a.limit })}`, 'GET')),
  lsp_spaces_runs_compare: handler('lsp_spaces_runs_compare', ['run_id', 'other_run_id'], (a) =>
    call('spaces', `/v1/runs/${enc(a.run_id)}/compare/${enc(a.other_run_id)}`, 'GET')),
};
