// -- ClaudeCode: Memory MCP tools. Add/search/update/forget/session-load typed memories.
import type { ToolDef, ToolHandler } from '../types.js';
import { call, okText } from '../client.js';

export const tools: ToolDef[] = [
  {
    name: 'lsp_memory_add',
    description:
      "Add a memory to LifeSpace Memory so future Claude sessions auto-retrieve it. CALL IMMEDIATELY when the user says 'remember this', 'save this', 'never do X again', 'always do Y', 'add a rule', 'add a preflight', 'note that…'. Pick type by phrasing: 'never/always' → rule (priority 900). 'before X check Y' → preflight. 'I prefer X' → feedback. 'we shipped X' → project. Default scope='project' with project_id from .claude/project.json. Idempotent on body fingerprint.",
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['rule', 'preflight', 'feedback', 'project', 'reference', 'user', 'thought'],
        },
        scope: { type: 'string', enum: ['global', 'tenant', 'repo', 'subtree', 'session'] },
        scope_ref: { type: 'string', description: 'Required when scope is repo/subtree/session.' },
        body: { type: 'string', description: 'The memory content (markdown).' },
        title: { type: 'string' },
        why: { type: 'string' },
        how_to_apply: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        applies_to: { type: 'array', items: { type: 'string' } },
        priority: { type: 'number' },
      },
      required: ['type', 'scope', 'body'],
    },
  },
  {
    name: 'lsp_memory_search',
    description:
      "Search Memory for context relevant to a query. Use when the user asks 'what did I decide about X', 'recall Y', 'memory check', or when you need rules/preflights beyond what's auto-loaded.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        context: {
          type: 'object',
          properties: {
            repo: { type: 'string' },
            subtree: { type: 'string' },
            applies_to: { type: 'array', items: { type: 'string' } },
          },
        },
        types: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['rule', 'preflight', 'feedback', 'project', 'reference', 'user', 'thought'],
          },
        },
        top_k: { type: 'number' },
      },
      required: ['query'],
    },
  },
  {
    name: 'lsp_memory_update',
    description: 'Supersede an existing memory with a new version. Old row is preserved in the audit chain.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        body: { type: 'string' },
        why: { type: 'string' },
        how_to_apply: { type: 'string' },
        priority: { type: 'number' },
      },
      required: ['id'],
    },
  },
  {
    name: 'lsp_memory_forget',
    description:
      'Soft-delete a memory. It stops appearing in retrieval but remains in the audit log. Use when the user says "forget that", "that rule is wrong", etc.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'lsp_memory_session_load',
    description:
      'Fetch the always-loaded + context-relevant memory bundle for the current session. Returns pre-rendered markdown. Call at session start or when verifying what memories are active.',
    inputSchema: {
      type: 'object',
      properties: {
        context: {
          type: 'object',
          properties: {
            repo: { type: 'string' },
            subtree: { type: 'string' },
            session_id: { type: 'string' },
            applies_to: { type: 'array', items: { type: 'string' } },
          },
        },
        user_prompt: { type: 'string' },
      },
    },
  },
];

export const handlers: Record<string, ToolHandler> = {
  lsp_memory_add: async (args) => okText(await call('memory', '/v1/memories', 'POST', args)),
  lsp_memory_search: async (args) => okText(await call('memory', '/v1/memories/search', 'POST', args)),
  lsp_memory_update: async (args) => {
    const { id, ...rest } = args as Record<string, unknown>;
    return okText(await call('memory', `/v1/memories/${id}`, 'PUT', rest));
  },
  lsp_memory_forget: async (args) => {
    const { id } = args as { id: string };
    await call('memory', `/v1/memories/${id}`, 'DELETE');
    return okText({ ok: true, id, forgotten: true });
  },
  lsp_memory_session_load: async (args) =>
    okText(await call('memory', '/v1/memories/session-load', 'POST', args ?? {})),
};
