// -- ClaudeCode: Dispatch MCP tools. Wraps POST /v1/send, GET /v1/messages, GET /v1/credits/balance.
import type { ToolDef, ToolHandler } from '../types.js';
import { call, okText, errText } from '../client.js';

// -- ClaudeCode 2026-08-30: the ONLY valid top-level props for lsp_dispatch_send.
// Dispatch's POST /v1/send destructures exactly these at the top level (send.ts)
// and reads subject/fromEmail/fromName/replyTo ONLY out of `config` (the adapters,
// sendgrid-email.ts). Promoting the email options to top-level params here means
// mapping them into config before the call, and rejecting anything else loudly —
// silent param loss is a known platform bug class (this is Dispatch task 4f8d0e2e:
// a natural top-level `subject` used to be dropped, shipping mail titled
// "Notification"). Keep in sync with the inputSchema below.
const DISPATCH_SEND_KEYS = new Set([
  'channel',
  'recipient',
  'body',
  'user_id',
  'cc',
  'bcc',
  'attachments',
  'subject',
  'fromEmail',
  'fromName',
  'replyTo',
  'config',
]);

// -- ClaudeCode 2026-08-30: email options promoted to top-level params. Each is
// mapped into `config` before the call (Dispatch reads them from there). An
// explicit top-level value WINS over the same key nested in config (deterministic).
const DISPATCH_EMAIL_PROMOTED = ['subject', 'fromEmail', 'fromName', 'replyTo'] as const;

export const tools: ToolDef[] = [
  {
    name: 'lsp_dispatch_send',
    description:
      "Send a message via Dispatch on any supported channel (SMS, email, Slack, Telegram, Pushover). Use this whenever the user says 'dispatch me', 'text me', 'email me when done', 'ping me', 'notify me', 'ding me', or similar. Dispatch resolves provider credentials from Keys, picks the right sender for the recipient's domain, and returns a message_id. Email supports multiple To recipients (pass an array), cc, bcc, and file attachments. For email, set the subject, sender alias, and reply-to as TOP-LEVEL params: `subject` (the email subject line — omit it and the message ships titled 'Notification'), `fromName` (display name), `fromEmail` (a SendGrid-verified sender), and `replyTo` (email string or {email,name}). Costs 1 credit for SMS; other channels are free.",
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
        // -- ClaudeCode 2026-08-30: subject/fromEmail/fromName/replyTo promoted to
        // top-level params (they used to be buried in config, where a natural
        // top-level pass silently dropped them — Dispatch task 4f8d0e2e). The
        // handler maps them into config before calling /v1/send; top-level wins
        // over the same key nested in config.
        subject: {
          type: 'string',
          description: "Email subject line (email channel only). Omit it and Dispatch titles the message 'Notification'.",
        },
        fromEmail: {
          type: 'string',
          description: 'Sender address (email channel only). Must be a SendGrid-verified sender for this tenant.',
        },
        fromName: {
          type: 'string',
          description: 'Sender display name (email channel only).',
        },
        replyTo: {
          // -- ClaudeCode: email string OR { email, name }. Beats the tenant's stored default.
          anyOf: [
            { type: 'string' },
            {
              type: 'object',
              properties: {
                email: { type: 'string' },
                name: { type: 'string' },
              },
              required: ['email'],
            },
          ],
          description: 'Route replies elsewhere (email channel only). An email string, or { email, name }. Always beats the tenant\'s stored default.',
        },
        config: {
          type: 'object',
          description:
            "Channel-specific optional config for anything not promoted to a top-level param. Email advanced keys: { text, style, headers, click_tracking, ... }. Pushover: { title?, priority?, sound?, url?, url_title? }. subject/fromEmail/fromName/replyTo are top-level params now — a top-level value wins if you also nest one here.",
          additionalProperties: true,
        },
      },
      required: ['channel', 'recipient', 'body'],
      // -- ClaudeCode 2026-08-30: reject unknown top-level props instead of
      // silently dropping them (Dispatch task 4f8d0e2e). The handler enforces
      // this too — the MCP server does not validate args against inputSchema.
      additionalProperties: false,
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
  // -- ClaudeCode 2026-08-30: reject unknown top-level props loudly and map the
  // promoted email options into `config` before the call. Without this, a caller
  // passing a natural top-level `subject` (or fromName/fromEmail/replyTo) had it
  // silently dropped — Dispatch reads those only from config (Dispatch task
  // 4f8d0e2e). The MCP server does not validate args against inputSchema, so the
  // handler enforces the whitelist itself.
  lsp_dispatch_send: async (args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    const unknown = Object.keys(a).filter((k) => !DISPATCH_SEND_KEYS.has(k));
    if (unknown.length) {
      return errText(
        new Error(
          `Unknown top-level propert${unknown.length > 1 ? 'ies' : 'y'} for lsp_dispatch_send: ${unknown.join(', ')}. ` +
            'Valid top-level keys: channel, recipient, body, user_id, cc, bcc, attachments, subject, fromEmail, fromName, replyTo, config. ' +
            'Anything else goes inside config.',
        ),
      );
    }
    // Fold the promoted email options into config; an explicit top-level value
    // WINS over the same key nested in config (deterministic).
    const { config: rawConfig, ...top } = a;
    const config: Record<string, unknown> = { ...((rawConfig as Record<string, unknown> | undefined) ?? {}) };
    for (const key of DISPATCH_EMAIL_PROMOTED) {
      if (top[key] !== undefined) config[key] = top[key];
      delete top[key];
    }
    const payload: Record<string, unknown> = { ...top };
    if (Object.keys(config).length) payload.config = config;
    return okText(await call('dispatch', '/v1/send', 'POST', payload));
  },
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
