// -- ClaudeCode: Trust MCP tools.
// Real routes (verified 2026-05-12 against Trust/src/routes/):
//   GET /v1/verify                            — verify caller's own JWT; returns { valid, user: <decoded claims> }
//   GET /v1/users                             — list users with at least one role in caller's tenant (admin scope = all)
//   GET /v1/tenants/:tenantId/roster          — tenant roster with email + role + name; for @-mentions, assignee pickers
// Other admin/agent/login/jwks routes are admin-internal; not exposed via MCP.
import type { ToolDef, ToolHandler } from '../types.js';
import { call, okText } from '../client.js';

export const tools: ToolDef[] = [
  {
    name: 'lsp_trust_whoami',
    description:
      "Return the caller's decoded JWT claims (email/user id, tenant_id, role, modules, exp). Use to verify the MCP install is authenticated correctly, or to confirm the active tenant identity. Wraps Trust's GET /v1/verify.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'lsp_trust_users_list',
    description:
      "List users visible to the caller's tenant (joined through trust_app_roles — returns users with ≥1 role in the caller's tenant). super_admin scope bypasses the filter and returns all users. Use when you need a real `assignee_user_id` (email) or `recipient_user_email` for a task/handoff. Wraps Trust GET /v1/users.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'lsp_trust_tenant_roster',
    description:
      "Get the tenant's people roster (email + role + name), keyed by tenant_id. Better than lsp_trust_users_list when you also need each person's role + display name (for picker UIs, @-mentions, or 'admins only' filters). Tenant-safe: super_admin bypass, else caller must be IN the target tenant. Wraps Trust GET /v1/tenants/:tenantId/roster.",
    inputSchema: {
      type: 'object',
      properties: {
        tenant_id: { type: 'string', description: 'Target tenant UUID. Use lsp_trust_whoami to get the caller\'s own tenant_id.' },
      },
      required: ['tenant_id'],
    },
  },
];

export const handlers: Record<string, ToolHandler> = {
  lsp_trust_whoami: async () => okText(await call('trust', '/v1/verify', 'GET')),
  lsp_trust_users_list: async () => okText(await call('trust', '/v1/users', 'GET')),
  lsp_trust_tenant_roster: async (args) => {
    const { tenant_id } = args as { tenant_id: string };
    return okText(await call('trust', `/v1/tenants/${tenant_id}/roster`, 'GET'));
  },
};
