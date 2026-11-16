// -- ClaudeCode: Memory MCP tools. Add/search/update/forget/session-load typed memories.
import type { ToolDef, ToolHandler } from '../types.js';
import { call, okText } from '../client.js';
import { authFor } from '../config.js';

// -- ClaudeCode 2026-11-15 (space facts): optional tenant to act on. Chief of
// Staff facts live ON the Space (its own sub-tenant of the customer's top
// tenant). The handler strips tenant_id from the body and sends it as the
// X-Tenant-Id header; Memory decides whether the caller may act there.
const TENANT_ID_PROP = {
  tenant_id: {
    type: 'string',
    description:
      "Optional. The tenant to act on, e.g. a Space's own id. Absent = your sign-in's own tenant. Only a sub-tenant of your own account is allowed.",
  },
} as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Split tenant_id off the args. Returns the rest (for the body) and the headers
 *  to send. Throws a plain error on a bad tenant_id. */
export function tenantHeaders(args: unknown): { rest: Record<string, unknown>; headers: Record<string, string> } {
  const { tenant_id, ...rest } = ((args ?? {}) as Record<string, unknown>);
  if (tenant_id === undefined || tenant_id === null || tenant_id === '') return { rest, headers: {} };
  if (typeof tenant_id !== 'string' || !UUID_RE.test(tenant_id)) {
    throw new Error('tenant_id must be a tenant id (a uuid).');
  }
  // Memory's API-key path ignores X-Tenant-Id (a key always acts on its own
  // tenant), so sending one there would silently land on the wrong tenant.
  // Only a Trust sign-in (a JWT) can carry it — refuse otherwise.
  if (authFor('memory').split('.').length !== 3) {
    throw new Error('tenant_id needs a Trust sign-in; an API key always acts on its own tenant.');
  }
  return { rest, headers: { 'X-Tenant-Id': tenant_id } };
}

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
        // -- ClaudeCode 2026-11-15 (memory expiry): optional expiry.
        expires_at: {
          type: 'string',
          description:
            'Optional. The last day this applies, as a date (YYYY-MM-DD; kept through the end of that day everywhere) or a datetime. Future only, at most 2 years.',
        },
        ...TENANT_ID_PROP,
      },
      required: ['type', 'scope', 'body'],
    },
  },
  {
    name: 'lsp_memory_search',
    description:
      "Search Memory for context relevant to a query. Use when the user asks 'what did I decide about X', 'recall Y', 'memory check', or when you need rules/preflights beyond what's auto-loaded. query is optional: an empty or missing query returns all candidates for the filter.",
    inputSchema: {
      type: 'object',
      properties: {
        // -- ClaudeCode 2026-11-15 (memory expiry): optional (not required).
        query: {
          type: 'string',
          description: 'Optional keyword. Leave it out to get every memory that matches the context and types.',
        },
        context: {
          type: 'object',
          properties: {
            repo: { type: 'string' },
            subtree: { type: 'string' },
            applies_to: { type: 'array', items: { type: 'string' } },
            // -- ClaudeCode 2026-11-15 (memory expiry): only tagged rows.
            applies_to_only: {
              type: 'boolean',
              description:
                'Optional. When true, return only memories tagged with one of the applies_to values; memories with no applies_to are left out.',
            },
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
        ...TENANT_ID_PROP,
      },
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
        // -- ClaudeCode 2026-11-15 (memory expiry): string sets it, null clears it.
        expires_at: {
          type: ['string', 'null'],
          description:
            'Optional. The last day this applies, as a date (YYYY-MM-DD; kept through the end of that day everywhere) or a datetime. Future only, at most 2 years. null clears it; leave it out to keep the current one.',
        },
        ...TENANT_ID_PROP,
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
      properties: { id: { type: 'string' }, ...TENANT_ID_PROP },
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
        ...TENANT_ID_PROP,
      },
    },
  },
];

export const handlers: Record<string, ToolHandler> = {
  // -- ClaudeCode 2026-11-15 (space facts): every handler strips tenant_id from
  // the body and sends it as X-Tenant-Id through call()'s extraHeaders.
  lsp_memory_add: async (args) => {
    const { rest, headers } = tenantHeaders(args);
    return okText(await call('memory', '/v1/memories', 'POST', rest, headers));
  },
  lsp_memory_search: async (args) => {
    const { rest, headers } = tenantHeaders(args);
    return okText(await call('memory', '/v1/memories/search', 'POST', rest, headers));
  },
  lsp_memory_update: async (args) => {
    const { rest: all, headers } = tenantHeaders(args);
    const { id, ...rest } = all;
    return okText(await call('memory', `/v1/memories/${id}`, 'PUT', rest, headers));
  },
  lsp_memory_forget: async (args) => {
    const { rest, headers } = tenantHeaders(args);
    const { id } = rest as { id: string };
    await call('memory', `/v1/memories/${id}`, 'DELETE', undefined, headers);
    return okText({ ok: true, id, forgotten: true });
  },
  lsp_memory_session_load: async (args) => {
    const { rest, headers } = tenantHeaders(args);
    return okText(await call('memory', '/v1/memories/session-load', 'POST', rest, headers));
  },
};
