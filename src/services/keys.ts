// -- ClaudeCode: Keys MCP tools. Credential vault access — get, list, list providers.
import type { ToolDef, ToolHandler } from '../types.js';
import { call, okText } from '../client.js';

export const tools: ToolDef[] = [
  {
    name: 'lsp_keys_get',
    description:
      "Fetch a credential from Keys for a specific provider and optional label. Use when the user says 'pull the X key', 'get the Y credential', 'fetch from Keys'. Never paste credentials into code or .env — Keys is the sole vault.",
    inputSchema: {
      type: 'object',
      properties: {
        provider: {
          type: 'string',
          description:
            "Provider id (e.g. 'sendgrid', 'twilio', 'openai', 'stripe', 'aws_iam', 'custom').",
        },
        label: {
          type: 'string',
          description: "Label for multi-credential-per-provider setups. Defaults to 'default' if omitted.",
        },
      },
      required: ['provider'],
    },
  },
  {
    name: 'lsp_keys_list',
    description: "List all stored credentials for the caller's tenant. Returns provider + label only, never credential values.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'lsp_keys_providers_list',
    description:
      'List all provider types available in the Keys catalog (sendgrid, twilio, openai, aws_iam, custom, etc.). Use when the user asks what providers are supported or what credentials they can store.',
    inputSchema: { type: 'object', properties: {} },
  },
];

export const handlers: Record<string, ToolHandler> = {
  lsp_keys_get: async (args) => {
    const { provider, label } = args as { provider: string; label?: string };
    const path = label ? `/v1/keys/${provider}?app=${encodeURIComponent(label)}` : `/v1/keys/${provider}`;
    return okText(await call('keys', path, 'GET'));
  },
  lsp_keys_list: async () => okText(await call('keys', '/v1/keys', 'GET')),
  lsp_keys_providers_list: async () => okText(await call('keys', '/v1/providers', 'GET')),
};
