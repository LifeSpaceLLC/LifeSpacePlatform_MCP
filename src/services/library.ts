// -- ClaudeCode: Library MCP tools. Federated content index — search + register entries.
import type { ToolDef, ToolHandler } from '../types.js';
import { call, okText } from '../client.js';

export const tools: ToolDef[] = [
  {
    name: 'lsp_library_search',
    description:
      "Ranked full-text search over Library content — titles + full transcripts of Drive docs, YouTube videos, PDFs, web pages, etc. Returns matches ordered by relevance, each with a highlighted `snippet` and `id`. Use when the user says 'search Library for X', 'what's in my library about Y?', 'find videos about Z'. To then read a full transcript as context, call lsp_library_get_content with the id.",
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Search query. Supports "quoted phrases", or, and -exclude.' },
        content_type: {
          type: 'string',
          description: 'Filter by content type (e.g. "youtube", "web", "pdf", "google-doc").',
        },
        folder_id: { type: 'string', description: 'Restrict search to a folder.' },
        limit: { type: 'number' },
      },
      required: ['q'],
    },
  },
  {
    name: 'lsp_library_get_content',
    description:
      "Pull the FULL text/transcript of one Library entry, to use as context (e.g. summarize it, compare against a document, answer questions about it). Get the `id` from lsp_library_search first. Returns { id, title, content_url, status, transcript }.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The Library entry id (from search results).' },
      },
      required: ['id'],
    },
  },
  {
    name: 'lsp_library_import_channel',
    description:
      "Bulk-import a whole YouTube channel into Library: pass a channel URL (youtube.com/@handle, /channel/UC…, or /c/…) and Library creates one entry per recent video (each auto-transcribed) — deduped, safe to re-run for new videos. Also accepts any single URL. Then search across them with lsp_library_search.",
    inputSchema: {
      type: 'object',
      properties: {
        channel_url: { type: 'string', description: 'A YouTube channel URL (or any content URL).' },
        folder_id: { type: 'string', description: 'Optional destination folder.' },
      },
      required: ['channel_url'],
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
  lsp_library_get_content: async (args) => {
    const { id } = (args ?? {}) as { id?: string };
    return okText(await call('library', `/v1/entries/${encodeURIComponent(String(id))}/content`, 'GET'));
  },
  lsp_library_import_channel: async (args) => {
    const { channel_url, folder_id } = (args ?? {}) as { channel_url?: string; folder_id?: string };
    return okText(await call('library', '/v1/entries', 'POST', { content_url: channel_url, folder_id }));
  },
  lsp_library_list_folders: async () => okText(await call('library', '/v1/folders', 'GET')),
};
