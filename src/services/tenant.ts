// -- ClaudeCode: Tenant MCP tools. List tenants, create/list briefings for AI onboarding.
import type { ToolDef, ToolHandler } from '../types.js';
import { call, okText } from '../client.js';

export const tools: ToolDef[] = [
  {
    name: 'lsp_tenant_list',
    description: "List tenants the caller can see. Admins see their subtree; super_admin sees all.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'lsp_tenant_briefing_create',
    description:
      "Create a one-shot briefing URL to onboard an AI into a tenant. Use when the user says 'onboard X', 'brief an AI for Y', 'mint a briefing for Z'. Returns a URL that, when fetched with Accept: application/json, yields the target AI's bearer JWT + inlined user guides + MCP config.",
    inputSchema: {
      type: 'object',
      properties: {
        agent_label: { type: 'string', description: "Human-readable name for the AI (e.g. 'Claude for AriWorld')." },
        parent_tenant_id: { type: 'string', description: 'UUID of the tenant the AI will operate inside.' },
        modules: {
          type: 'array',
          items: { type: 'string' },
          description: "Array of module ids to grant (e.g. ['dispatch','library','memory']).",
        },
        note: { type: 'string' },
      },
      required: ['agent_label', 'parent_tenant_id', 'modules'],
    },
  },
  {
    name: 'lsp_tenant_briefing_list',
    description: "List briefings created by the caller's tenant.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'lsp_tenant_briefing_revoke',
    description: "Revoke a briefing by id. Kills the URL immediately; in-flight JWTs stay valid until natural exp (soft revocation today).",
    inputSchema: {
      type: 'object',
      properties: { briefing_id: { type: 'string' } },
      required: ['briefing_id'],
    },
  },
];

export const handlers: Record<string, ToolHandler> = {
  lsp_tenant_list: async () => okText(await call('tenant', '/v1/tenants', 'GET')),
  lsp_tenant_briefing_create: async (args) => okText(await call('tenant', '/v1/briefings', 'POST', args)),
  lsp_tenant_briefing_list: async () => okText(await call('tenant', '/v1/briefings', 'GET')),
  lsp_tenant_briefing_revoke: async (args) => {
    const { briefing_id } = args as { briefing_id: string };
    await call('tenant', `/v1/briefings/${briefing_id}`, 'DELETE');
    return okText({ ok: true, briefing_id, revoked: true });
  },
};
