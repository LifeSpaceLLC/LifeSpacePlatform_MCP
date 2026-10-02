// -- ClaudeCode: Keys MCP tools. Credential vault access — get, list, list providers.
import type { ToolDef, ToolHandler } from '../types.js';
import { call, okText, errText } from '../client.js'; // ClaudeCode 2026-10-02 11:35 AM PDT — + errText

export const tools: ToolDef[] = [
  {
    name: 'lsp_keys_get',
    description:
      "Fetch a credential from Keys for a specific provider and optional label. Use when the user says 'pull the X key', 'get the Y credential', 'fetch from Keys'. Never paste credentials into code or .env — Keys is the sole vault. WARNING: this tool's result puts the secret value into the conversation; when a script, CLI or program needs the secret, use lsp_keys_link instead.", // ClaudeCode 2026-10-02 11:35 AM PDT — warning sentence added; behavior unchanged
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
  // ClaudeCode 2026-10-02 11:35 AM PDT — response-wrapped key hand-off.
  {
    name: 'lsp_keys_link',
    description:
      'A script, CLI or program you launch needs a secret — use this instead of lsp_keys_get so the value never enters the conversation. ' +
      'Returns a SINGLE-USE link (expires in ttl_minutes, default 5, max 10) plus the bundle\'s field NAMES and ready-to-run bash/python usage. ' +
      'Hand the link to the process; the process fetches the value itself. Never print, echo or log the value. ' +
      'Resolves the key exactly like lsp_keys_get, including keys inherited from ancestor tenants.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: {
          type: 'string',
          description: "Provider id (e.g. 'sendgrid', 'twilio', 'openai', 'stripe', 'aws_iam', 'custom').",
        },
        label: {
          type: 'string',
          description: "Label for multi-credential-per-provider setups. Same resolution as lsp_keys_get (tries this label, then 'default').",
        },
        ttl_minutes: {
          type: 'number',
          description: 'Minutes until the link expires. Default 5, min 1, max 10.',
        },
      },
      required: ['provider'],
      additionalProperties: false,
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
  // ClaudeCode 2026-10-02 11:35 AM PDT — lsp_keys_link. Rejects unknown props
  // loudly (the MCP server does not validate args against inputSchema). The
  // result carries the link, expiry, field NAMES and usage — never a value.
  lsp_keys_link: async (args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    const unknown = Object.keys(a).filter((k) => !KEYS_LINK_KEYS.has(k));
    if (unknown.length) {
      return errText(
        new Error(
          `Unknown propert${unknown.length > 1 ? 'ies' : 'y'} for lsp_keys_link: ${unknown.join(', ')}. ` +
            'Valid keys: provider, label, ttl_minutes.',
        ),
      );
    }
    if (typeof a.provider !== 'string' || !a.provider) return errText(new Error('provider is required'));
    if (a.label !== undefined && typeof a.label !== 'string') return errText(new Error('label must be a string'));
    if (a.ttl_minutes !== undefined && typeof a.ttl_minutes !== 'number') {
      return errText(new Error('ttl_minutes must be a number (1-10)'));
    }
    // Mirror lsp_keys_get: its label rides as ?app= (label, then 'default').
    const body: Record<string, unknown> = { provider: a.provider };
    if (a.label) body.app = a.label;
    if (a.ttl_minutes !== undefined) body.ttl_minutes = a.ttl_minutes;
    const r = (await call('keys', '/v1/keys/link', 'POST', body)) as {
      link: string;
      expires_at: string;
      provider: string;
      label: string;
      fields: string[];
      inherited?: boolean;
    };
    return okText(buildLinkResult(r));
  },
  lsp_keys_list: async () => okText(await call('keys', '/v1/keys', 'GET')),
  lsp_keys_providers_list: async () => okText(await call('keys', '/v1/providers', 'GET')),
};

// ClaudeCode 2026-10-02 11:35 AM PDT — lsp_keys_link helpers.
const KEYS_LINK_KEYS = new Set(['provider', 'label', 'ttl_minutes']);

function shQuote(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

function envName(field: string): string {
  const n = field.replace(/[^A-Za-z0-9_]/g, '_');
  return /^[A-Za-z_]/.test(n) ? n : `_${n}`;
}

function buildLinkResult(r: {
  link: string;
  expires_at: string;
  provider: string;
  label: string;
  fields: string[];
  inherited?: boolean;
}) {
  const f = r.fields[0] ?? 'FIELD';
  const v = envName(f);
  return {
    link: r.link,
    expires_at: r.expires_at,
    single_use: true,
    provider: r.provider,
    label: r.label,
    fields: r.fields,
    inherited: r.inherited ?? false,
    rules: [
      'This link is SINGLE-USE: the first fetch consumes it; any later fetch returns 410. Get a new link for each run.',
      'It expires at expires_at even if unused.',
      'NEVER print, echo, log or return the secret value — not in output, files, commits or chat. Let the launched process read it directly.',
      'One fetch = either ONE field via ?field=<name> (text/plain) or the WHOLE bundle as JSON (no ?field). Not both.',
    ],
    usage: {
      bash_one_field:
        `# Injects ${f} as an env var for ONE process only; nothing is echoed. -f makes curl fail (empty) on 404/410.\n` +
        `${v}="$(curl -sf ${shQuote(`${r.link}?field=${encodeURIComponent(f)}`)})" your_command --args`,
      python_whole_bundle:
        `# Launch: pass only the LINK; the script fetches the JSON itself.\n` +
        `LSP_KEY_LINK=${shQuote(r.link)} python3 your_script.py\n\n` +
        `# your_script.py\n` +
        `import json, os, urllib.request\n` +
        `with urllib.request.urlopen(os.environ.pop("LSP_KEY_LINK")) as resp:\n` +
        `    creds = json.load(resp)["keys"]  # {${r.fields.map((x) => `"${x}": ...`).join(', ')}} - never print it\n` +
        `# use creds["${f}"] ...`,
    },
  };
}
