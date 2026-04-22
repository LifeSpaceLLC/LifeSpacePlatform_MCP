// -- ClaudeCode: Trust MCP tools.
// Real routes (verified 2026-04-21 against Trust/src/routes/verify.ts):
//   GET /v1/verify — verify the caller's own Trust JWT; returns { valid, user: <decoded claims> }
// Admin/agent/login/jwks routes are admin-internal; not exposed via MCP.
import type { ToolDef, ToolHandler } from '../types.js';
import { call, okText } from '../client.js';

export const tools: ToolDef[] = [
  {
    name: 'lsp_trust_whoami',
    description:
      "Return the caller's decoded JWT claims (email/user id, tenant_id, role, modules, exp). Use to verify the MCP install is authenticated correctly, or to confirm the active tenant identity. Wraps Trust's GET /v1/verify.",
    inputSchema: { type: 'object', properties: {} },
  },
];

export const handlers: Record<string, ToolHandler> = {
  lsp_trust_whoami: async () => okText(await call('trust', '/v1/verify', 'GET')),
};
