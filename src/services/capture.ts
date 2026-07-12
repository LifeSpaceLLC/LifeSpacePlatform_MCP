// -- ClaudeCode: Capture MCP tools — universal intake CRUD.
// Phase 1 = dumb capture, no classification. Tools mirror the API exactly.
import type { ToolDef, ToolHandler } from '../types.js';
import { call, okText } from '../client.js';

export const tools: ToolDef[] = [
  {
    name: 'lsp_capture_create',
    description:
      "Create a capture in LifeSpace Capture — the universal tenant-scoped inbox for thoughts, photos, screenshots, and links. CALL when the user says 'capture this', 'save this thought', 'park this for later', 'add to inbox', 'remember this link'. Phase 1 stores raw text + URL + optional blob_id; classification and routing land in Phase 2. Returns { id, captured_at }.",
    inputSchema: {
      type: 'object',
      properties: {
        note: { type: 'string', description: 'The text of the capture (the thought, comment, or transcription).' },
        url: { type: 'string', description: 'A captured link (auto-extracted from note if present).' },
        blob_id: { type: 'string', description: 'Pre-uploaded blob UUID from POST /v1/capture/blob.' },
        source: {
          type: 'string',
          enum: ['web', 'ios_shortcut', 'telegram', 'whatsapp', 'imessage', 'email', 'mcp'],
          description: 'Where the capture came from. Defaults to "mcp" when invoked via this tool.',
        },
      },
    },
  },
  {
    name: 'lsp_capture_list',
    description:
      "List the user's captures in their tenant inbox. Newest first. Filter by source ('web','ios_shortcut','telegram','whatsapp','mcp'), status ('active' default, or 'discarded'), or substring search across note + URL.",
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['active', 'discarded'] },
        source: { type: 'string', enum: ['web', 'ios_shortcut', 'telegram', 'whatsapp', 'imessage', 'email', 'mcp'] },
        q: { type: 'string', description: 'Substring search on note + URL.' },
        limit: { type: 'number' },
        offset: { type: 'number' },
      },
    },
  },
  {
    name: 'lsp_capture_get',
    description: 'Get one capture by id with full detail (note, URL, blob URL if image, source, captured_at, meta).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'lsp_capture_update',
    description: 'Edit a capture\'s note text. Phase 1 only mutates note; Phase 2 may add tag/intent edits.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        note: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'lsp_capture_delete',
    description: 'Soft-delete a capture (status=discarded). 30-day retention before sweeper purge.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    // -- ClaudeCode (2026-07-12): the receipt seam for the route-inbound skill.
    // Stamps a handled-receipt on a Capture item — what it became, by whom.
    // Maps to POST /v1/capture/:id/receipts (Inbound D3 endpoint, reused, not new).
    name: 'lsp_capture_stamp_receipt',
    description:
      "Stamp a handled-receipt on a Capture item — record what it BECAME after you acted on it (a ticket, task, agent job, Library entry, or a dismissal). CALL after the route-inbound skill (or any agent) turns a Capture item into something. Marks the item handled (handled_at/handled_by); action='dismiss' also discards it. Canonical actions: ticket | task | agent | library | dismiss | route | other. Returns the receipt + the item's new handled state.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The Capture item id to stamp.' },
        action: {
          type: 'string',
          enum: ['ticket', 'task', 'agent', 'library', 'dismiss', 'route', 'other'],
          description: 'What the item became. "dismiss" also discards the item.',
        },
        outcome_kind: { type: 'string', description: 'Module/type that received it, e.g. projects_task, library_entry, ticket.' },
        outcome_id: { type: 'string', description: 'Id of the thing it became.' },
        outcome_url: { type: 'string', description: 'Deep link to the outcome, if one exists.' },
        summary: { type: 'string', description: 'One plain-English line, e.g. "→ Projects task: follow up Tuesday".' },
        actor_kind: { type: 'string', enum: ['agent', 'team_member'], description: 'Defaults to "agent" for MCP callers.' },
        actor: { type: 'string', description: 'Who acted, e.g. "route-inbound". Defaults to the caller identity.' },
      },
      required: ['id', 'action'],
    },
  },
];

export const handlers: Record<string, ToolHandler> = {
  lsp_capture_create: async (args) => {
    const body = { source: 'mcp', ...(args as Record<string, unknown>) };
    return okText(await call('capture', '/v1/capture', 'POST', body));
  },
  lsp_capture_list: async (args) => {
    const params = new URLSearchParams();
    const a = args as Record<string, unknown>;
    if (a.status) params.set('status', String(a.status));
    if (a.source) params.set('source', String(a.source));
    if (a.q) params.set('q', String(a.q));
    if (a.limit) params.set('limit', String(a.limit));
    if (a.offset) params.set('offset', String(a.offset));
    const qs = params.toString();
    return okText(await call('capture', `/v1/capture${qs ? `?${qs}` : ''}`, 'GET'));
  },
  lsp_capture_get: async (args) => {
    const { id } = args as { id: string };
    return okText(await call('capture', `/v1/capture/${id}`, 'GET'));
  },
  lsp_capture_update: async (args) => {
    const { id, ...rest } = args as Record<string, unknown>;
    return okText(await call('capture', `/v1/capture/${id}`, 'PATCH', rest));
  },
  lsp_capture_delete: async (args) => {
    const { id } = args as { id: string };
    await call('capture', `/v1/capture/${id}`, 'DELETE');
    return okText({ ok: true, id, deleted: true });
  },
  lsp_capture_stamp_receipt: async (args) => {
    const { id, ...body } = args as Record<string, unknown>;
    // actor_kind defaults to 'agent' for MCP callers; the service fills actor
    // from the token identity when omitted.
    if (!body.actor_kind) body.actor_kind = 'agent';
    return okText(await call('capture', `/v1/capture/${id}/receipts`, 'POST', body));
  },
};
