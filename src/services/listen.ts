// -- ClaudeCode: Listen MCP tools. Wraps the Listen service REST API — the
// "what wakes the system up" surface: register sources + consumers (declarative
// handlers), connect gmail, pull namespaced tags, replay. Spec §15. Kept small —
// it's the contract, not a workflow engine.
import type { ToolDef, ToolHandler } from '../types.js';
import { call, okText } from '../client.js';

export const tools: ToolDef[] = [
  {
    name: 'lsp_listen_list_sources',
    description:
      "List the tenant's Listen sources (inbound triggers) — gmail polls, catch-hook webhooks, http polls. Shows transport, provider, status, cursor, last-polled. Use for 'what is Listen watching', 'what sources are connected'.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'lsp_listen_register_source',
    description:
      "Register a new inbound source. transport='webhook' (provider 'catch_hook' — returns a minted inbound_url anything can POST to) or transport='api_poll' (provider 'gmail' = mailbox poll [then call lsp_listen_connect_source]; 'http'/'rss' = poll a REST endpoint/feed). config carries preset settings (poll url, records_path, id_field, gmail label, etc.).",
    inputSchema: {
      type: 'object',
      properties: {
        transport: { type: 'string', enum: ['webhook', 'api_poll'] },
        provider: { type: 'string', enum: ['catch_hook', 'gmail', 'http', 'rss'] },
        account_ref: { type: 'string', description: 'Which account/endpoint (e.g. mailbox email, a label).' },
        config: { type: 'object', description: 'Preset settings (url, records_path, id_field, timestamp_field, since_param, label, max_results).', additionalProperties: true },
        poll_interval_sec: { type: 'number', description: 'For api_poll: how often the scheduler polls.' },
        keys_credential_label: { type: 'string', description: 'For http with auth: the Keys label holding the api_key bundle.' },
        cursor_overlap_sec: { type: 'number', description: 'Date-range lookback overlap so boundary records are never missed (dedup absorbs it).' },
      },
      required: ['transport', 'provider'],
    },
  },
  {
    name: 'lsp_listen_connect_source',
    description:
      "Get the Google consent URL to connect a gmail source's mailbox (one-click 'Connect Gmail'). Returns { auth_url } the user opens. Call after registering a gmail source. Tokens land in Keys; the scheduler then polls the mailbox.",
    inputSchema: {
      type: 'object',
      properties: { source_id: { type: 'string', description: 'The gmail source id from lsp_listen_register_source.' } },
      required: ['source_id'],
    },
  },
  {
    name: 'lsp_listen_register_consumer',
    description:
      "Register a consumer that listens to a source with a declarative handler (a rule list, never code). consumer_key (<kind>:<owner>:<purpose>, e.g. 'assistant:agent_7f3a:family') is the unit of subscription AND the tag namespace prefix. handler = { rules:[{ when:<all/any/not tree of field_*/in_list/always or email shorthands>, then:{ effect:'tag'|'skip'|'reject', tag?, reason?, stop? } }] }. Cheap rules first.",
    inputSchema: {
      type: 'object',
      properties: {
        consumer_key: { type: 'string', description: '<kind>:<owner>:<purpose> — unique per tenant, becomes the tag namespace.' },
        kind: { type: 'string', enum: ['assistant', 'module', 'operator', 'agent'] },
        owner_ref: { type: 'string', description: 'agent/session/user/module id that owns this registration.' },
        source_id: { type: 'string' },
        handler: { type: 'object', description: 'Declarative rule list (see description).', additionalProperties: true },
        tag_retention_days: { type: 'number' },
        backfill_days: { type: 'number', description: 'Back-check: scan the last N days of the source against this new handler right now (omit or 0 = forward-only). Response includes a backfill summary { from, fetched, scanned, tagged }.' },
      },
      required: ['consumer_key', 'source_id', 'handler'],
    },
  },
  {
    name: 'lsp_listen_list_tags',
    description:
      "Pull a consumer's namespaced tags since a watermark (the contract between Listen and consumers). Each tag carries a reason + a record pointer the consumer uses to fetch the body live. Use to see 'what did Listen surface for me'. Poll with `since` = the last tag's created_at.",
    inputSchema: {
      type: 'object',
      properties: {
        consumer_key: { type: 'string' },
        since: { type: 'string', description: 'ISO watermark — only tags created after this.' },
        tag: { type: 'string', description: "Optional tag filter; supports '*' glob (e.g. '*.scanlist.*')." },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'lsp_listen_replay',
    description:
      "Replay a source from a point in time — re-fetch + re-evaluate handlers (e.g. after fixing a handler bug). Dedup absorbs overlap, so no duplicates downstream. Use for 'reprocess last Tuesday', 'backfill since X'.",
    inputSchema: {
      type: 'object',
      properties: {
        source_id: { type: 'string' },
        from: { type: 'string', description: 'ISO point to replay from.' },
      },
      required: ['source_id'],
    },
  },
];

export const handlers: Record<string, ToolHandler> = {
  lsp_listen_list_sources: async () => okText(await call('listen', '/v1/sources', 'GET')),
  lsp_listen_register_source: async (args) => okText(await call('listen', '/v1/sources', 'POST', args)),
  lsp_listen_connect_source: async (args) => {
    const { source_id } = args as { source_id: string };
    return okText(await call('listen', `/v1/oauth/gmail/start?source_id=${encodeURIComponent(source_id)}`, 'GET'));
  },
  lsp_listen_register_consumer: async (args) => okText(await call('listen', '/v1/consumers', 'POST', args)),
  lsp_listen_list_tags: async (args) => {
    const qs = new URLSearchParams(args as Record<string, string>).toString();
    return okText(await call('listen', `/v1/tags${qs ? `?${qs}` : ''}`, 'GET'));
  },
  lsp_listen_replay: async (args) => {
    const { source_id, ...body } = args as { source_id: string } & Record<string, unknown>;
    return okText(await call('listen', `/v1/sources/${source_id}/replay`, 'POST', body));
  },
};
