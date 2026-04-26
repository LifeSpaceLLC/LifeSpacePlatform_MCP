// -- ClaudeCode: Handoff MCP tools. Scaffolded — returns 503 until Handoff deploys.
import type { ToolDef, ToolHandler } from '../types.js';
import { call, okText } from '../client.js';

export const tools: ToolDef[] = [
  {
    name: 'lsp_handoff_compose',
    description:
      "Compose a handoff packet from the current repo + branch. Use when the user says 'handoff to X', 'hand this off', 'pass to Y', 'baton to Z'. Returns a draft packet with AI-generated summary, changed files, and acceptance criteria — user reviews before sending.",
    inputSchema: {
      type: 'object',
      properties: {
        repo_url: { type: 'string' },
        branch: { type: 'string' },
        recipient: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['user', 'email'] },
            user_id: { type: 'string' },
            email: { type: 'string' },
          },
          required: ['type'],
        },
        intent: {
          type: 'string',
          enum: ['continue', 'finish_and_ship', 'review_and_merge', 'fresh_session', 'discontinue_and_postmortem'],
        },
        hints: {
          type: 'object',
          properties: {
            include_knowledge_paths: { type: 'array', items: { type: 'string' } },
            include_memory_since: { type: 'string' },
            include_project_ids: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      required: ['repo_url', 'branch', 'intent'],
    },
  },
  {
    name: 'lsp_handoff_create',
    description:
      "Create a handoff packet. Call after composing and getting user approval. Recipient is optional — omit for share-link-only mode ('generate handoff'). Returns the created packet with id.",
    inputSchema: {
      type: 'object',
      properties: {
        repo_url: { type: 'string', description: 'Git remote URL' },
        branch: { type: 'string', description: 'Branch name' },
        head_commit_sha: { type: 'string', description: 'HEAD commit SHA (optional)' },
        title: { type: 'string', description: 'One-sentence title' },
        summary_md: { type: 'string', description: 'Markdown summary of what was done and why' },
        changed_files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, change_type: { type: 'string' }, note: { type: 'string' } }, required: ['path', 'change_type'] } },
        acceptance_criteria: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' } }, required: ['id', 'text'] } },
        open_questions_md: { type: 'string' },
        intent: { type: 'string', enum: ['continue', 'finish_and_ship', 'review_and_merge', 'fresh_session', 'discontinue_and_postmortem'] },
        recipient_type: { type: 'string', enum: ['user', 'agent'], description: 'Omit for share-link-only (no email)' },
        recipient_email: { type: 'string', description: 'Recipient email. Omit for share-link-only.' },
        recipient_user_email: { type: 'string' },
        recipient_agent_tenant_id: { type: 'string' },
        context_refs: { type: 'array', items: { type: 'object', properties: { module: { type: 'string' }, ref_id: { type: 'string' }, label: { type: 'string' } }, required: ['module', 'ref_id'] } },
      },
      required: ['repo_url', 'branch', 'title', 'summary_md', 'intent'],
    },
  },
  {
    name: 'lsp_handoff_send',
    description:
      "Transition a drafted handoff packet to 'sent'. ALWAYS returns a share_url (public, 7-day, no login required). If a recipient is set, also sends a Dispatch email. The share_url in the response MUST be shown to the user — it is the product.",
    inputSchema: {
      type: 'object',
      properties: { packet_id: { type: 'string' } },
      required: ['packet_id'],
    },
  },
  {
    name: 'lsp_handoff_list',
    description: "List handoff packets — optionally filtered by state or recipient.",
    inputSchema: {
      type: 'object',
      properties: {
        state: {
          type: 'string',
          enum: ['drafting', 'sent', 'in_progress', 'accepted', 'rejected', 'discontinued'],
        },
        recipient: { type: 'string' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'lsp_handoff_transition',
    description: "Drive the state machine — accept, reject, discontinue. Reason + postmortem optional.",
    inputSchema: {
      type: 'object',
      properties: {
        packet_id: { type: 'string' },
        to_state: { type: 'string', enum: ['in_progress', 'accepted', 'rejected', 'discontinued'] },
        reason: { type: 'string' },
        postmortem_md: { type: 'string' },
      },
      required: ['packet_id', 'to_state'],
    },
  },
];

export const handlers: Record<string, ToolHandler> = {
  lsp_handoff_compose: async (args) => okText(await call('handoff', '/v1/packets/compose', 'POST', args)),
  lsp_handoff_create: async (args) => okText(await call('handoff', '/v1/packets', 'POST', args)),
  lsp_handoff_send: async (args) => {
    const { packet_id } = args as { packet_id: string };
    return okText(await call('handoff', `/v1/packets/${packet_id}/send`, 'POST'));
  },
  lsp_handoff_list: async (args) => {
    const parts: string[] = [];
    for (const [k, v] of Object.entries((args ?? {}) as Record<string, unknown>)) {
      if (v !== undefined && v !== null) parts.push(`${k}=${encodeURIComponent(String(v))}`);
    }
    const qs = parts.length ? `?${parts.join('&')}` : '';
    return okText(await call('handoff', `/v1/packets${qs}`, 'GET'));
  },
  lsp_handoff_transition: async (args) => {
    const { packet_id, ...rest } = args as Record<string, unknown>;
    return okText(await call('handoff', `/v1/packets/${packet_id}/transitions`, 'POST', rest));
  },
};
