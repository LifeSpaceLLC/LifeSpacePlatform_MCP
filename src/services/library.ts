// -- ClaudeCode: Library MCP tools. Federated content index — search + register entries.
import type { ToolDef, ToolHandler } from '../types.js';
import { call, okText } from '../client.js';

export const tools: ToolDef[] = [
  {
    name: 'lsp_library_search',
    description:
      "Search Library content (Drive docs, YouTube videos, PDFs, web pages, meeting recordings, etc.). Use when the user says 'search Library for X', 'what's in my library about Y?', 'find my notes on Z'.",
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string' },
        content_type: {
          type: 'string',
          description: 'Filter by content type (e.g. "google_doc", "youtube_video", "pdf", "meeting_recording").',
        },
        folder_id: { type: 'string', description: 'Restrict search to a folder.' },
        limit: { type: 'number' },
      },
      required: ['q'],
    },
  },
  {
    name: 'lsp_library_register',
    description:
      "Register external content in Library so it becomes searchable. Use when the user says 'add X to Library', 'index this Drive folder', 'track this YouTube channel'.",
    inputSchema: {
      type: 'object',
      properties: {
        // -- ClaudeCode: MUST be `content_url` — the Library API (POST /v1/entries)
        // requires `content_url`; the handler forwards args verbatim (no mapping),
        // so the tool param name has to match the API field exactly. Was `source_url`,
        // which 400'd every governed register call. (ticket 2ea2d2d0)
        content_url: { type: 'string' },
        content_type: { type: 'string', description: 'Optional — Library auto-detects from the URL if omitted.' },
        title: { type: 'string' },
        folder_id: { type: 'string' },
        metadata: { type: 'object', additionalProperties: true },
      },
      required: ['content_url'],
    },
  },
  {
    name: 'lsp_library_list_folders',
    description: 'List Library folders for the tenant.',
    inputSchema: { type: 'object', properties: {} },
  },
];

export const handlers: Record<string, ToolHandler> = {
  lsp_library_search: async (args) => {
    const parts: string[] = [];
    for (const [k, v] of Object.entries((args ?? {}) as Record<string, unknown>)) {
      if (v !== undefined && v !== null) parts.push(`${k}=${encodeURIComponent(String(v))}`);
    }
    return okText(await call('library', `/v1/entries?${parts.join('&')}`, 'GET'));
  },
  lsp_library_register: async (args) => okText(await call('library', '/v1/entries', 'POST', args)),
  lsp_library_list_folders: async () => okText(await call('library', '/v1/folders', 'GET')),
};
