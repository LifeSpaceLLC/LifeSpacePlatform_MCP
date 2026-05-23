// -- ClaudeCode: Assistant MCP tools. Wraps the Assistant coordinator REST API —
// vertical resolution, the daily huddle, commitment tracking, and dump-triage.
// AI-first: these are the agent's hands; the Admin UI just verifies + approves.
import type { ToolDef, ToolHandler } from '../types.js';
import { call, okText } from '../client.js';

export const tools: ToolDef[] = [
  {
    name: 'lsp_assistant_vertical',
    description:
      "Resolve this tenant's assistant vertical from tenant.type — returns the voice (family / personal / work / neutral), the lexicon to use, which UserGuide is the charter, and available Packs. Call at startup so you speak the right language ('Ari's coverage' vs 'the team's deliverables').",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'lsp_assistant_huddle',
    description:
      "Get (or list recent) daily huddle briefs for a principal — the 'what's today, what's due, what's slipping, what needs a decision' rundown. Use for 'give me my brief', 'what's the huddle', 'catch me up'.",
    inputSchema: {
      type: 'object',
      properties: {
        principal: { type: 'string', description: 'Optional — whose brief (e.g. a parent).' },
        for_date: { type: 'string', description: 'Optional — YYYY-MM-DD.' },
      },
    },
  },
  {
    name: 'lsp_assistant_list_commitments',
    description:
      "List the open loops / dropped balls the assistant is tracking (owed-by / owed-to / due). Use for 'what do I owe', 'what's outstanding', 'anything slipping'. status defaults to 'open'.",
    inputSchema: {
      type: 'object',
      properties: { status: { type: 'string', enum: ['open', 'done', 'dropped'], description: "Default 'open'." } },
    },
  },
  {
    name: 'lsp_assistant_track_commitment',
    description:
      "Log a commitment / open loop the assistant should chase (a thing owed or owed-to, optionally with a due date). Use when extracting a to-do from an email/text/meeting — 'sign Ari's permission slip by Thursday', 'follow up with the vendor'.",
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        owed_by: { type: 'string', description: 'Who owes it.' },
        owed_to: { type: 'string', description: "Who it's owed to." },
        due_at: { type: 'string', description: 'ISO datetime, if there is a deadline.' },
        source: { type: 'string', description: "Where it came from (dump / email / meeting / manual)." },
        subject_ref: { type: 'string', description: 'Optional — link to a Calendar subject.' },
      },
      required: ['title'],
    },
  },
  {
    name: 'lsp_assistant_resolve_commitment',
    description: "Mark a commitment done or dropped. Use for 'I did X', 'cancel that', 'mark the permission slip done'.",
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, status: { type: 'string', enum: ['done', 'dropped', 'open'] } },
      required: ['id', 'status'],
    },
  },
  {
    name: 'lsp_assistant_triage',
    description:
      "Record a triaged inbound item (the dump-triage trail). After extracting events/tasks from a dumped email/text/PDF/transcript, log what you did with it: disposition act (handled) / table (queued for the huddle) / ask (needs the human) / escalate (a real risk). Use ask/escalate to put something in the human's 'needs your answer' queue.",
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', enum: ['dump', 'email', 'text', 'pdf', 'transcript'] },
        sender: { type: 'string' },
        disposition: { type: 'string', enum: ['act', 'table', 'ask', 'escalate'] },
        confidence: { type: 'number', description: '0-1 confidence in the extraction.' },
        extracted: { type: 'object', description: 'Structured events/tasks/facts pulled out (include a "summary" for the human queue).', additionalProperties: true },
      },
      required: ['source'],
    },
  },
];

export const handlers: Record<string, ToolHandler> = {
  lsp_assistant_vertical: async () => okText(await call('assistant', '/v1/vertical', 'GET')),
  lsp_assistant_huddle: async (args) => {
    const qs = new URLSearchParams(args as Record<string, string>).toString();
    return okText(await call('assistant', `/v1/huddle${qs ? `?${qs}` : ''}`, 'GET'));
  },
  lsp_assistant_list_commitments: async (args) => {
    const status = (args as { status?: string } | undefined)?.status ?? 'open';
    return okText(await call('assistant', `/v1/commitments?status=${status}`, 'GET'));
  },
  lsp_assistant_track_commitment: async (args) => okText(await call('assistant', '/v1/commitments', 'POST', args)),
  lsp_assistant_resolve_commitment: async (args) => {
    const { id, ...body } = args as { id: string } & Record<string, unknown>;
    return okText(await call('assistant', `/v1/commitments/${id}`, 'PATCH', body));
  },
  lsp_assistant_triage: async (args) => okText(await call('assistant', '/v1/inbox', 'POST', args)),
};
