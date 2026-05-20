// -- ClaudeCode: Dispatch MCP tools. Wraps POST /v1/send, GET /v1/messages, GET /v1/credits/balance.
import type { ToolDef, ToolHandler } from '../types.js';
import { call, okText } from '../client.js';

export const tools: ToolDef[] = [
  {
    name: 'lsp_dispatch_send',
    description:
      "Send a message via Dispatch on any supported channel (SMS, email, Slack, Telegram, Pushover). Use this whenever the user says 'dispatch me', 'text me', 'email me when done', 'ping me', 'notify me', 'ding me', or similar. Dispatch resolves provider credentials from Keys, picks the right sender for the recipient's domain, and returns a message_id. Email supports multiple To recipients (pass an array), cc, bcc, and file attachments. Costs 1 credit for SMS; other channels are free.",
    inputSchema: {
      type: 'object',
      properties: {
        channel: {
          type: 'string',
          enum: ['sms', 'email', 'slack', 'telegram', 'pushover'],
          description: "Channel to send on. SMS costs 1 credit; others are free.",
        },
        recipient: {
          // -- ClaudeCode: string for single recipient, OR array of strings for
          // multiple To: addresses (email only — all recipients see each other).
          anyOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' } },
          ],
          description:
            "Channel-specific: E.164 phone for sms (+15551234567), email address for email, Slack channel ID for slack, numeric chat ID for telegram, Pushover user key for pushover. For email, pass an ARRAY of addresses to send to multiple To: recipients (they see each other — use bcc for privacy).",
        },
        body: { type: 'string', description: 'Message body. Email accepts plain text, markdown, or HTML — Dispatch renders markdown (and converts bullet lists) automatically.' },
        cc: {
          type: 'array',
          items: { type: 'string' },
          description: 'Email addresses to CC. Email channel only.',
        },
        bcc: {
          type: 'array',
          items: { type: 'string' },
          description: 'Email addresses to BCC. Email channel only.',
        },
        attachments: {
          // -- ClaudeCode: email-only file attachments. content MUST be base64.
          type: 'array',
          description:
            'File attachments (email channel only). Max 10 files, 25MB total. Each item: { filename, content, type?, disposition? }.',
          items: {
            type: 'object',
            properties: {
              filename: { type: 'string', description: 'Display filename, e.g. "invoice.pdf".' },
              content: { type: 'string', description: 'Base64-encoded file content (required).' },
              type: { type: 'string', description: 'MIME type, e.g. "application/pdf". Defaults to application/octet-stream.' },
              disposition: { type: 'string', enum: ['attachment', 'inline'], description: 'Defaults to "attachment".' },
            },
            required: ['filename', 'content'],
          },
        },
        config: {
          type: 'object',
          description:
            "Channel-specific optional config. Email: { subject, fromEmail?, fromName? }. Pushover: { title?, priority?, sound?, url?, url_title? }.",
          additionalProperties: true,
        },
      },
      required: ['channel', 'recipient', 'body'],
    },
  },
  {
    name: 'lsp_dispatch_list_messages',
    description:
      'List recent Dispatch messages for the caller. Use when the user asks to see recent sends, troubleshoot a message, or check delivery status.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max rows to return (default 20).' },
      },
    },
  },
  {
    name: 'lsp_dispatch_get_message',
    description:
      'Fetch a single Dispatch message by its message_id. Returns status, channel, recipient, timestamp, provider message id, and error details if failed.',
    inputSchema: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'The message_id returned from lsp_dispatch_send.' },
      },
      required: ['message_id'],
    },
  },
  {
    name: 'lsp_dispatch_credits',
    description:
      "Get the caller's credit balance + low-threshold. Returns { tenant_id, balance, low_threshold }. SMS sends cost 1 credit each; other channels are free.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'lsp_dispatch_credits_ledger',
    description: "Return credit transaction history for the tenant (top-ups, sends, adjustments).",
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number' },
        offset: { type: 'number' },
      },
    },
  },
];

export const handlers: Record<string, ToolHandler> = {
  lsp_dispatch_send: async (args) => okText(await call('dispatch', '/v1/send', 'POST', args)),
  lsp_dispatch_list_messages: async (args) => {
    const limit = (args as { limit?: number } | undefined)?.limit;
    const qs = limit ? `?limit=${limit}` : '';
    return okText(await call('dispatch', `/v1/messages${qs}`, 'GET'));
  },
  lsp_dispatch_get_message: async (args) => {
    const { message_id } = args as { message_id: string };
    return okText(await call('dispatch', `/v1/messages/${message_id}`, 'GET'));
  },
  lsp_dispatch_credits: async () => okText(await call('dispatch', '/v1/credits', 'GET')),
  lsp_dispatch_credits_ledger: async (args) => {
    const { limit, offset } = (args ?? {}) as { limit?: number; offset?: number };
    const parts: string[] = [];
    if (limit !== undefined) parts.push(`limit=${limit}`);
    if (offset !== undefined) parts.push(`offset=${offset}`);
    const qs = parts.length ? `?${parts.join('&')}` : '';
    return okText(await call('dispatch', `/v1/credits/ledger${qs}`, 'GET'));
  },
};
