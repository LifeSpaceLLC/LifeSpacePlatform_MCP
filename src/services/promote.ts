// -- ClaudeCode: Promote MCP tools — Meta ad campaign cloner.
// All clones land in Meta as PAUSED — Greg flips them ACTIVE manually as the
// spend-governance gate (Phase 2 spending governance hooks not yet wired).
import type { ToolDef, ToolHandler } from '../types.js';
import { call, okText } from '../client.js';

export const tools: ToolDef[] = [
  {
    name: 'lsp_promote_credentials_list',
    description: "List the Meta ad-account credentials registered in Keys for the calling tenant. Returns the credential names you pass to other Promote tools.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'lsp_promote_campaigns_list',
    description: "List source campaigns on a Meta ad account. Use this to pick a campaign to snapshot.",
    inputSchema: {
      type: 'object',
      properties: {
        credential_name: { type: 'string', description: 'The Meta credential name from lsp_promote_credentials_list' },
        limit: { type: 'number' },
      },
      required: ['credential_name'],
    },
  },
  {
    name: 'lsp_promote_snapshot_capture',
    description: "Capture a Meta campaign as a snapshot. Reads the full campaign tree (campaign + adsets + ads + creatives) and persists it. Returns the new snapshot id.",
    inputSchema: {
      type: 'object',
      properties: {
        credential_name: { type: 'string' },
        meta_campaign_id: { type: 'string' },
        label: { type: 'string', description: 'Human-readable label, e.g. "April 2026 lead-gen"' },
      },
      required: ['credential_name', 'meta_campaign_id'],
    },
  },
  {
    name: 'lsp_promote_snapshot_list',
    description: "List campaign snapshots for the calling tenant.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'lsp_promote_snapshot_get',
    description: "Read a snapshot's full Meta campaign tree (campaign + adsets + ads + creatives, raw_payload).",
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'lsp_promote_clone_create',
    description: "Create a clone-run from a snapshot + swap manifest. Manifest can override campaign name/budget/dates, adset budgets/targeting, and per-ad headline/primary_text/description/link_url/image_url/url_tags. Run starts in 'captured' state.",
    inputSchema: {
      type: 'object',
      properties: {
        source_snapshot_id: { type: 'string' },
        swap_manifest: {
          type: 'object',
          description: 'Shape: { campaign?, adsets?: [{adset_id, ...}], ads?: [{ad_id, headline?, primary_text?, description?, link_url?, image_url?, url_tags?, call_to_action_type?}] }',
        },
        label: { type: 'string' },
      },
      required: ['source_snapshot_id', 'swap_manifest'],
    },
  },
  {
    name: 'lsp_promote_clone_plan',
    description: "Run the plan step on a clone-run: generates the structured diff between snapshot and proposed clone. Transitions state to 'ready'.",
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'lsp_promote_clone_diff',
    description: "Read the structured diff for a clone-run (added/removed/changed entries + summary).",
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'lsp_promote_clone_execute',
    description: "Push a 'ready' clone-run to Meta. Creates the campaign + adsets + creatives + ads, ALL in PAUSED state. Transitions to 'executed'. Greg flips PAUSED → ACTIVE manually in Meta Ads Manager.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        credential_name: { type: 'string', description: 'Which Meta credential to use for this execute' },
      },
      required: ['id', 'credential_name'],
    },
  },
  {
    name: 'lsp_promote_clone_adjust',
    description: "Update the swap_manifest on a clone-run that hasn't executed yet (states: captured/planning/ready). Resets state to 'planning' so re-plan is required.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        swap_manifest: { type: 'object' },
        reason: { type: 'string' },
      },
      required: ['id', 'swap_manifest'],
    },
  },
  {
    name: 'lsp_promote_clone_cancel',
    description: "Cancel a clone-run that hasn't executed (captured/planning/ready → cancelled).",
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'lsp_promote_clone_list',
    description: "List clone-runs for the calling tenant. Filterable by state.",
    inputSchema: {
      type: 'object',
      properties: {
        state: { type: 'string', enum: ['captured', 'planning', 'ready', 'executing', 'executed', 'failed', 'cancelled'] },
      },
    },
  },
  {
    name: 'lsp_promote_clone_get',
    description: "Read a clone-run's detail (current state, swap_manifest, diff, full transition history).",
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'lsp_promote_clone_prompt',
    description: "Generate a Claude-Code paste-ready prompt for working on a clone-run. Use when Greg wants to hand a clone-run to a fresh Claude session for adjustments.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        task: { type: 'string', description: 'What you want the next Claude session to do' },
      },
      required: ['id'],
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
  lsp_promote_credentials_list: async () => okText(await call('promote', '/v1/credentials', 'GET')),
  lsp_promote_campaigns_list: async (args) => {
    const a = args as { credential_name: string; limit?: number };
    return okText(await call('promote', `/v1/campaigns${qs(a as Record<string, unknown>)}`, 'GET'));
  },
  lsp_promote_snapshot_capture: async (args) => okText(await call('promote', '/v1/snapshots', 'POST', args)),
  lsp_promote_snapshot_list: async () => okText(await call('promote', '/v1/snapshots?limit=100', 'GET')),
  lsp_promote_snapshot_get: async (args) => {
    const { id } = args as { id: string };
    return okText(await call('promote', `/v1/snapshots/${id}`, 'GET'));
  },
  lsp_promote_clone_create: async (args) => okText(await call('promote', '/v1/clones', 'POST', args)),
  lsp_promote_clone_plan: async (args) => {
    const { id } = args as { id: string };
    return okText(await call('promote', `/v1/clones/${id}/plan`, 'POST'));
  },
  lsp_promote_clone_diff: async (args) => {
    const { id } = args as { id: string };
    return okText(await call('promote', `/v1/clones/${id}/diff`, 'GET'));
  },
  lsp_promote_clone_execute: async (args) => {
    const { id, ...rest } = args as { id: string; credential_name: string };
    return okText(await call('promote', `/v1/clones/${id}/execute`, 'POST', rest));
  },
  lsp_promote_clone_adjust: async (args) => {
    const { id, ...rest } = args as Record<string, unknown>;
    return okText(await call('promote', `/v1/clones/${id}/adjust`, 'POST', rest));
  },
  lsp_promote_clone_cancel: async (args) => {
    const { id } = args as { id: string };
    return okText(await call('promote', `/v1/clones/${id}/cancel`, 'POST'));
  },
  lsp_promote_clone_list: async (args) => okText(await call('promote', `/v1/clones${qs(args as Record<string, unknown>)}`, 'GET')),
  lsp_promote_clone_get: async (args) => {
    const { id } = args as { id: string };
    return okText(await call('promote', `/v1/clones/${id}`, 'GET'));
  },
  lsp_promote_clone_prompt: async (args) => {
    const { id, ...rest } = args as Record<string, unknown>;
    return okText(await call('promote', `/v1/clones/${id}/prompt`, 'POST', rest));
  },
};
