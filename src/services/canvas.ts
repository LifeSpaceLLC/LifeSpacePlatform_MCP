// -- ClaudeCode: Canvas MCP tools — autofill renders, duplicate designs, refresh.
// Backend: https://canvas.lifespace.com (LIVE 2026-04-27).
// Spec: LifeSpace_Canvas_Spec.md · UserGuide: LifeSpace_Canvas_UserGuide.md
import type { ToolDef, ToolHandler } from '../types.js';
import { call, okText } from '../client.js';

export const tools: ToolDef[] = [
  {
    name: 'lsp_canvas_list_connectors',
    description:
      "List the Canva connectors registered for the calling tenant. Each connector binds a Keys credential to a Canva account/workspace. Returns connector ids you pass to render/duplicate/upload tools.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'lsp_canvas_list_templates',
    description:
      "List Canva Brand Templates available to a connector. Read-through cache (1h TTL) — refreshes from Canva on miss. Use this to discover templates before rendering. Brand Templates are required for autofill (Canva Pro/Teams feature); regular designs can only be duplicated.",
    inputSchema: {
      type: 'object',
      properties: {
        connector_id: { type: 'string' },
        search: { type: 'string', description: 'Filter templates by name substring' },
      },
      required: ['connector_id'],
    },
  },
  {
    name: 'lsp_canvas_get_template',
    description:
      "Fetch a template's full metadata + autofill field schema. Returns the field names + types you supply in the autofill_payload. Call this before lsp_canvas_render to know what fields the template expects.",
    inputSchema: {
      type: 'object',
      properties: {
        connector_id: { type: 'string' },
        external_template_id: { type: 'string' },
      },
      required: ['connector_id', 'external_template_id'],
    },
  },
  {
    name: 'lsp_canvas_render',
    description:
      "Render a Brand Template with autofill: swap text/image fields and export as PNG/JPG. Mirrors bytes to Library and returns library_asset_ref (stable). Cache-keyed on (tenant, template, autofill_payload, format) — identical inputs return cached result synchronously. This is the primary 'create from prompt' tool: AI maps the user's request onto the template's autofill fields and calls this.",
    inputSchema: {
      type: 'object',
      properties: {
        connector_id: { type: 'string' },
        external_template_id: { type: 'string' },
        autofill_payload: {
          type: 'object',
          description:
            'Map of field_name → value. Text fields take a string. Image fields take {asset_id} where asset_id comes from lsp_canvas_upload or a previous Canva-uploaded asset.',
        },
        output_format: { type: 'string', enum: ['png', 'jpg'] },
        requested_by_module: { type: 'string', description: "e.g. 'manual', 'promote', 'mcp'" },
      },
      required: ['connector_id', 'external_template_id', 'autofill_payload'],
    },
  },
  {
    name: 'lsp_canvas_duplicate_design',
    description:
      "Duplicate any existing Canva design — Brand Template OR regular design — and mirror the first snapshot to Library. Returns the new external_design_id (which can then be opened in Canva for manual editing, or autofilled if the source was a Brand Template). This is the primary 'duplicate that design' tool.",
    inputSchema: {
      type: 'object',
      properties: {
        connector_id: { type: 'string' },
        source_design_id: { type: 'string', description: "Canva design id to clone" },
        title: { type: 'string', description: "Title for the new copy" },
        output_format: { type: 'string', enum: ['png', 'jpg'] },
      },
      required: ['connector_id', 'source_design_id'],
    },
  },
  {
    name: 'lsp_canvas_refresh_render',
    description:
      "Re-snapshot a render's design from Canva — captures the design's *current* state, including any manual edits the user made via the Open-in-Canva deep-link. Updates the Library asset in place. Use this after telling the user to 'open in Canva and edit' to pull the new state back into LSP.",
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: "Render id to refresh" } },
      required: ['id'],
    },
  },
  {
    name: 'lsp_canvas_list_renders',
    description:
      "List recent renders for the calling tenant. Filter by state, connector, or template. Use to find a previous render to refresh or duplicate from.",
    inputSchema: {
      type: 'object',
      properties: {
        connector_id: { type: 'string' },
        state: { type: 'string', enum: ['pending', 'rendering', 'exported', 'failed', 'cached_hit'] },
        template: { type: 'string', description: 'external_template_id' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'lsp_canvas_upload',
    description:
      "Push a source image into Canva's asset library so it can be referenced in autofill image fields. Body takes either source_url (Canvas fetches the bytes) or source_library_asset_ref (Canvas pulls from Library). Returns external_asset_id — pass this in autofill_payload's image fields as {asset_id: <id>}.",
    inputSchema: {
      type: 'object',
      properties: {
        connector_id: { type: 'string' },
        source_url: { type: 'string', description: 'Public URL of the image to upload' },
        source_library_asset_ref: { type: 'string', description: 'Library asset id (alternative to source_url)' },
        filename: { type: 'string' },
      },
      required: ['connector_id'],
    },
  },
];

function qs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (v !== undefined && v !== null) parts.push(`${k}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

export const handlers: Record<string, ToolHandler> = {
  lsp_canvas_list_connectors: async () => okText(await call('canvas', '/v1/connectors', 'GET')),
  lsp_canvas_list_templates: async (args) => {
    const { connector_id, search } = args as { connector_id: string; search?: string };
    return okText(await call('canvas', `/v1/templates${qs({ connector_id, search })}`, 'GET'));
  },
  lsp_canvas_get_template: async (args) => {
    const { connector_id, external_template_id } = args as { connector_id: string; external_template_id: string };
    return okText(await call('canvas', `/v1/templates/${encodeURIComponent(external_template_id)}${qs({ connector_id })}`, 'GET'));
  },
  lsp_canvas_render: async (args) => okText(await call('canvas', '/v1/renders', 'POST', args)),
  lsp_canvas_duplicate_design: async (args) => okText(await call('canvas', '/v1/designs/duplicate', 'POST', args)),
  lsp_canvas_refresh_render: async (args) => {
    const { id } = args as { id: string };
    return okText(await call('canvas', `/v1/renders/${id}/refresh`, 'POST'));
  },
  lsp_canvas_list_renders: async (args) => okText(await call('canvas', `/v1/renders${qs(args as Record<string, unknown>)}`, 'GET')),
  lsp_canvas_upload: async (args) => okText(await call('canvas', '/v1/uploads', 'POST', args)),
};
