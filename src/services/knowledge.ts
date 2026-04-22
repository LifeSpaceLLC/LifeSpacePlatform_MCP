// -- ClaudeCode: Knowledge MCP tools. AI-first markdown doc store.
// Real routes (verified 2026-04-21 against Knowledge/src/routes/docs.ts + search.ts):
//   PUT    /v1/docs/*   — create or update (wildcard = tenant-relative path)
//   GET    /v1/docs/*   — read single doc
//   DELETE /v1/docs/*   — soft-delete
//   GET    /v1/docs     — list (no wildcard)
//   POST   /v1/search   — keyword search (tsvector), body { query, limit?, include_inherited?, include_content? }
//   GET    /v1/history/*— doc version history
import type { ToolDef, ToolHandler } from '../types.js';
import { call, okText } from '../client.js';

export const tools: ToolDef[] = [
  {
    name: 'lsp_knowledge_write',
    description:
      "Create or update a tenant-scoped markdown doc in Knowledge. Use when the user says 'log this in Knowledge', 'document this decision', 'write a doc about X'. Path is tenant-relative (e.g. 'decisions/2026/auth-redesign.md'). Frontmatter is parsed from the content or provided explicitly.",
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: "Tenant-relative path (e.g. 'decisions/2026/auth.md'). Must end in .md." },
        content: { type: 'string', description: 'Full markdown content, including YAML frontmatter if any.' },
        frontmatter: {
          type: 'object',
          additionalProperties: true,
          description: 'Optional explicit frontmatter; overrides any frontmatter parsed from content.',
        },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'lsp_knowledge_read',
    description: 'Read a Knowledge doc at a tenant-relative path.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'lsp_knowledge_delete',
    description: "Soft-delete a Knowledge doc. Use when the user says 'remove that doc', 'delete X from Knowledge'.",
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'lsp_knowledge_list',
    description: 'List Knowledge docs for the caller tenant (and inherited, if enabled server-side).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'lsp_knowledge_search',
    description:
      "Keyword-search Knowledge docs. Grammar supports quotes, OR, -exclude via websearch_to_tsquery. Use when the user says 'search Knowledge for X', 'find my doc about Y', 'what did I write on Z?'.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search text.' },
        limit: { type: 'number', description: 'Max results (default 20, max 100).' },
        include_inherited: {
          type: 'boolean',
          description: 'Walk the tenant chain upward (default true).',
        },
        include_content: {
          type: 'boolean',
          description: 'Return full doc content with each hit (default false — returns metadata only).',
        },
        frontmatter_filter: {
          type: 'object',
          additionalProperties: true,
          description: 'Restrict hits to docs whose frontmatter matches these fields.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'lsp_knowledge_history',
    description: 'Version history for a single Knowledge doc path.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
];

// Knowledge wildcard routes don't URL-encode slashes — pass the raw path.
function docsPath(p: string): string {
  // Strip leading slashes; Knowledge routes mount as '/v1/docs/*'
  const clean = p.replace(/^\/+/, '');
  return `/v1/docs/${clean}`;
}
function historyPath(p: string): string {
  const clean = p.replace(/^\/+/, '');
  return `/v1/history/${clean}`;
}

export const handlers: Record<string, ToolHandler> = {
  lsp_knowledge_write: async (args) => {
    const { path, content, frontmatter } = args as {
      path: string;
      content: string;
      frontmatter?: Record<string, unknown>;
    };
    return okText(await call('knowledge', docsPath(path), 'PUT', { content, frontmatter }));
  },
  lsp_knowledge_read: async (args) => {
    const { path } = args as { path: string };
    return okText(await call('knowledge', docsPath(path), 'GET'));
  },
  lsp_knowledge_delete: async (args) => {
    const { path } = args as { path: string };
    await call('knowledge', docsPath(path), 'DELETE');
    return okText({ ok: true, path, deleted: true });
  },
  lsp_knowledge_list: async () => okText(await call('knowledge', '/v1/docs', 'GET')),
  lsp_knowledge_search: async (args) => okText(await call('knowledge', '/v1/search', 'POST', args)),
  lsp_knowledge_history: async (args) => {
    const { path } = args as { path: string };
    return okText(await call('knowledge', historyPath(path), 'GET'));
  },
};
