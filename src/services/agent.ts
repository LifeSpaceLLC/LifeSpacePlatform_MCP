// -- ClaudeCode: Agent MCP tools. Tenant-scoped machine-claimable work queue
// (LifeSpace_Agent_Spec.md, frozen 2026-07-01). The envelope carries all
// governance; these tools are thin wrappers over the live routes:
//   GET  /v1/intents | /v1/commands | /v1/statuses   — closed sets (never hardcode)
//   POST /v1/tasks                                    — create envelope (draft | enqueue:true)
//   PATCH /v1/tasks/:id                               — queue/cancel/edit draft
//   POST /v1/claim                                    — atomic claim (capability gate + budget)
//   POST /v1/tasks/:id/heartbeat|plan|gate|approvals|complete|verify|enqueue-child
//   GET|PUT /v1/policy
import type { ToolDef, ToolHandler } from '../types.js';
import { call, okText } from '../client.js';

export const tools: ToolDef[] = [
  {
    name: 'lsp_agent_compose',
    description:
      "Start composing an agent work envelope: returns the live closed sets (intents, commands, statuses) plus this tenant's policy (always-gated action classes, budgets). Use BEFORE drafting a task with lsp_agent_enqueue — never guess intents or commands. Pair with lsp_skills_search to pin required_skills.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'lsp_agent_enqueue',
    description:
      "Create an agent work envelope. Defaults to status 'draft' (compose proposes, never enqueues); pass enqueue:true only when the user has approved queueing. To queue an existing draft, pass task_id alone. The server injects tenant policy gates — they cannot be composed away.",
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Existing draft to queue (ignores other fields).' },
        title: { type: 'string' },
        intent: { type: 'string', description: 'From GET /v1/intents (lsp_agent_compose).' },
        description: { type: 'string' },
        required_tools: { type: 'array', items: { type: 'string' }, description: 'LSP module ids the runner JWT must hold.' },
        required_skills: {
          type: 'array',
          items: { type: 'object', properties: { skill_key: { type: 'string' }, version: {} } },
          description: "Pinned skills [{skill_key, version}] — resolve '@latest' to a concrete version at compose time.",
        },
        context_refs: {
          type: 'array',
          items: { type: 'object', properties: { module: { type: 'string' }, ref_id: { type: 'string' }, label: { type: 'string' } } },
          description: 'Handoff-shape refs into knowledge/memory/projects/library.',
        },
        acceptance: {
          type: 'array',
          items: { type: 'object' },
          description: "Typed checks [{kind: http_probe|command|db_assert|file_exists, spec, expected}].",
        },
        verify_by: { type: 'string', enum: ['self', 'other_agent', 'human'] },
        constraints: { type: 'object', description: 'denied_tools[], denied_actions[], boundaries{}, budget{max_turns,max_minutes,max_cost_usd}.' },
        gates: { type: 'array', items: { type: 'object' }, description: 'Extra human gates [{gate_id, position, approver, channel}].' },
        on_success: { type: 'array', items: { type: 'object' }, description: "Completion commands [{command, params, mode}] — command ids from lsp_agent_compose." },
        on_failure: { type: 'array', items: { type: 'object' } },
        project_ref: { type: 'object', description: '{project_id, task_id} linking the demand-side Projects task.' },
        priority: { type: 'number', description: 'Numeric score, default 100. Higher claims first.' },
        max_attempts: { type: 'number' },
        billable: { type: 'boolean' },
        parent_task_id: { type: 'string' },
        enqueue: { type: 'boolean', description: 'true = queued immediately; default false = draft pending approval.' },
      },
    },
  },
  {
    name: 'lsp_agent_claim',
    description:
      "Claim the next eligible queued task for THIS session to execute (atomic — no double claims). Returns the envelope + pinned skill bodies + runner instruction, or {claimed:false, reason: empty|budget_exhausted|no_eligible_tasks}. Use when the user says 'flush the queue', 'work the agent queue', 'claim a task'. Heartbeat while working; complete when done.",
    inputSchema: {
      type: 'object',
      properties: {
        runner_id: { type: 'string', description: "Stable runner name (e.g. 'claude-session-greg-1'). Reuse it for heartbeat/complete." },
        session_id: { type: 'string', description: 'Optional resume handle (Claude session id).' },
      },
      required: ['runner_id'],
    },
  },
  {
    name: 'lsp_agent_heartbeat',
    description:
      'Extend the lease on a claimed task and optionally update the plan[] progress checklist. Call at least every 10 minutes while executing — an expired lease re-queues the task for another runner.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        runner_id: { type: 'string' },
        plan: { type: 'array', items: { type: 'object' }, description: '[{step_id, label, status, note}] full replacement.' },
      },
      required: ['task_id', 'runner_id'],
    },
  },
  {
    name: 'lsp_agent_gate',
    description:
      "Hit a human-approval gate mid-execution: records the request, parks the task awaiting_human, releases your lease (any runner resumes after approval via plan[]), and notifies the approver. Use when the envelope's gates require sign-off before the next step (deploy, external send).",
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        gate_id: { type: 'string' },
        note: { type: 'string', description: 'What you are asking the approver to approve (be specific — commit SHA, recipient, amount).' },
      },
      required: ['task_id', 'gate_id'],
    },
  },
  {
    name: 'lsp_agent_complete',
    description:
      "Report a claimed task's outcome. success → verification begins (self-checks, a second agent, or a human per the envelope's verify_by); failure → retry or dead-letter. Include tokens_used/cost_usd when known — they feed the billable ledger.",
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        runner_id: { type: 'string' },
        outcome: { type: 'string', enum: ['success', 'failure'] },
        result_summary: { type: 'string' },
        tokens_used: { type: 'number' },
        cost_usd: { type: 'number' },
        checks: { type: 'array', items: { type: 'object' }, description: 'Self-run acceptance check results.' },
      },
      required: ['task_id', 'runner_id', 'outcome'],
    },
  },
  {
    name: 'lsp_agent_verify',
    description:
      "Post verification results for a task in 'verifying'. YOU MUST NOT BE ITS EXECUTOR (server enforces 403). Run every acceptance check adversarially, audit denied_actions, then report passed true/false.",
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        runner_id: { type: 'string' },
        passed: { type: 'boolean' },
        checks: { type: 'array', items: { type: 'object' }, description: 'Per-check results.' },
        note: { type: 'string' },
      },
      required: ['task_id', 'runner_id', 'passed'],
    },
  },
  {
    name: 'lsp_agent_approve',
    description:
      "Approve or reject a gate on a task awaiting human sign-off (admin/tenant_admin only; recorded append-only with your principal). Use when the user says 'approve it', 'let it deploy', 'reject that send'.",
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        gate_id: { type: 'string' },
        decision: { type: 'string', enum: ['approved', 'rejected'] },
        note: { type: 'string' },
      },
      required: ['task_id', 'gate_id', 'decision'],
    },
  },
  {
    name: 'lsp_agent_list',
    description:
      "List agent tasks for this tenant. Filter by status (draft|queued|claimed|executing|awaiting_human|verifying|done|failed|dead_letter|cancelled) or intent. 'awaiting_human' = the approvals inbox; 'dead_letter' = stuck work needing attention.",
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string' },
        intent: { type: 'string' },
        limit: { type: 'number' },
        offset: { type: 'number' },
      },
    },
  },
  {
    name: 'lsp_agent_get',
    description: 'Fetch one agent task: full envelope, plan[] progress, append-only approvals timeline, and chained children.',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string' } },
      required: ['task_id'],
    },
  },
  {
    name: 'lsp_agent_policy',
    description:
      "Read or update this tenant's agent governance policy: minutes_per_hour / max_task_minutes / max_concurrent time budgets, always_gate action classes (external_dispatch, spend, git_push, build_deploy by default), pause, billing defaults. Pass no fields to read. Updates need tenant_admin.",
    inputSchema: {
      type: 'object',
      properties: {
        minutes_per_hour: { type: 'number' },
        max_task_minutes: { type: 'number' },
        max_concurrent: { type: 'number' },
        always_gate: { type: 'array', items: { type: 'string' } },
        paused_until: { type: 'string', description: 'ISO timestamp, or null to unpause.' },
        billable_default: { type: 'boolean' },
        billing_rate: { type: 'number' },
      },
    },
  },
  {
    name: 'lsp_agent_template_list',
    description:
      "List this tenant's agent task templates (reusable envelopes: pinned skills + tools + context refs + acceptance + commands, minus instance specifics). Use before composing — if a template matches, instantiate instead of free-composing.",
    inputSchema: {
      type: 'object',
      properties: { status: { type: 'string', enum: ['active', 'archived'] } },
    },
  },
  {
    name: 'lsp_agent_template_get',
    description: 'Fetch one agent task template by its key, including instructions and params_hint (what instance details an instantiation must supply).',
    inputSchema: {
      type: 'object',
      properties: { template_key: { type: 'string' } },
      required: ['template_key'],
    },
  },
  {
    name: 'lsp_agent_template_write',
    description:
      "Create or update a reusable agent task template. Use when the user says 'make this a template', 'save this as a reusable agent'. Carries everything EXCEPT instance specifics: intent, generic instructions, params_hint, required_skills (pin concrete versions), required_tools, context_refs, acceptance, on_success/on_failure commands.",
    inputSchema: {
      type: 'object',
      properties: {
        template_key: { type: 'string', description: 'Slug, unique per tenant (a-z 0-9 -).' },
        name: { type: 'string' },
        intent: { type: 'string', description: 'From GET /v1/intents (lsp_agent_compose).' },
        instructions: { type: 'string', description: 'The generic how — instance details get appended at instantiate.' },
        params_hint: { type: 'string', description: 'What instance specifics an instantiator must supply.' },
        required_tools: { type: 'array', items: { type: 'string' } },
        required_skills: { type: 'array', items: { type: 'object', properties: { skill_key: { type: 'string' }, version: {} } } },
        context_refs: { type: 'array', items: { type: 'object', properties: { module: { type: 'string' }, ref_id: { type: 'string' }, label: { type: 'string' } } } },
        acceptance: { type: 'array', items: { type: 'object' } },
        verify_by: { type: 'string', enum: ['self', 'other_agent', 'human'] },
        constraints: { type: 'object' },
        gates: { type: 'array', items: { type: 'object' } },
        on_success: { type: 'array', items: { type: 'object' } },
        on_failure: { type: 'array', items: { type: 'object' } },
        priority: { type: 'number' },
        max_attempts: { type: 'number' },
        billable: { type: 'boolean' },
      },
      required: ['template_key'],
    },
  },
  {
    name: 'lsp_agent_template_instantiate',
    description:
      "Stamp a task from a template: template envelope + instance title/details -> DRAFT task (policy gates injected server-side). Use when the user says 'create X from the Y template', 'run the dashboard template for client Z'. Pass enqueue:true only with explicit user approval.",
    inputSchema: {
      type: 'object',
      properties: {
        template_key: { type: 'string' },
        title: { type: 'string' },
        details: { type: 'string', description: "Instance-specific instructions (fills the template's params_hint)." },
        context_refs: { type: 'array', items: { type: 'object' }, description: 'ADDED to the template refs.' },
        project_ref: { type: 'object' },
        priority: { type: 'number' },
        enqueue: { type: 'boolean' },
      },
      required: ['template_key', 'title'],
    },
  },
];

export const handlers: Record<string, ToolHandler> = {
  lsp_agent_compose: async () => {
    const [intents, commands, statuses, policy] = await Promise.all([
      call('agent', '/v1/intents', 'GET'),
      call('agent', '/v1/commands', 'GET'),
      call('agent', '/v1/statuses', 'GET'),
      call('agent', '/v1/policy', 'GET'),
    ]);
    return okText({
      compose_guide:
        'Draft the envelope from these closed sets. Pin required_skills to concrete versions (lsp_skills_search → lsp_skills_get). The server injects policy gates for always_gate action classes — do not try to omit them. Output a DRAFT via lsp_agent_enqueue (enqueue:false) and show it to the user before queueing.',
      intents,
      commands,
      statuses,
      policy,
    });
  },
  lsp_agent_enqueue: async (args) => {
    const { task_id, ...envelope } = args as { task_id?: string } & Record<string, unknown>;
    if (task_id) {
      return okText(await call('agent', `/v1/tasks/${encodeURIComponent(task_id)}`, 'PATCH', { status: 'queued' }));
    }
    return okText(await call('agent', '/v1/tasks', 'POST', envelope));
  },
  lsp_agent_claim: async (args) => {
    return okText(await call('agent', '/v1/claim', 'POST', args));
  },
  lsp_agent_heartbeat: async (args) => {
    const { task_id, ...rest } = args as { task_id: string } & Record<string, unknown>;
    return okText(await call('agent', `/v1/tasks/${encodeURIComponent(task_id)}/heartbeat`, 'POST', rest));
  },
  lsp_agent_gate: async (args) => {
    const { task_id, ...rest } = args as { task_id: string } & Record<string, unknown>;
    return okText(await call('agent', `/v1/tasks/${encodeURIComponent(task_id)}/gate`, 'POST', rest));
  },
  lsp_agent_complete: async (args) => {
    const { task_id, ...rest } = args as { task_id: string } & Record<string, unknown>;
    return okText(await call('agent', `/v1/tasks/${encodeURIComponent(task_id)}/complete`, 'POST', rest));
  },
  lsp_agent_verify: async (args) => {
    const { task_id, ...rest } = args as { task_id: string } & Record<string, unknown>;
    return okText(await call('agent', `/v1/tasks/${encodeURIComponent(task_id)}/verify`, 'POST', rest));
  },
  lsp_agent_approve: async (args) => {
    const { task_id, ...rest } = args as { task_id: string } & Record<string, unknown>;
    return okText(await call('agent', `/v1/tasks/${encodeURIComponent(task_id)}/approvals`, 'POST', rest));
  },
  lsp_agent_list: async (args) => {
    const { status, intent, limit, offset } = args as { status?: string; intent?: string; limit?: number; offset?: number };
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (intent) params.set('intent', intent);
    if (limit) params.set('limit', String(limit));
    if (offset) params.set('offset', String(offset));
    const qs = params.toString();
    return okText(await call('agent', `/v1/tasks${qs ? `?${qs}` : ''}`, 'GET'));
  },
  lsp_agent_get: async (args) => {
    const { task_id } = args as { task_id: string };
    return okText(await call('agent', `/v1/tasks/${encodeURIComponent(task_id)}`, 'GET'));
  },
  lsp_agent_policy: async (args) => {
    const fields = args as Record<string, unknown>;
    if (Object.keys(fields).length === 0) {
      return okText(await call('agent', '/v1/policy', 'GET'));
    }
    return okText(await call('agent', '/v1/policy', 'PUT', fields));
  },
  lsp_agent_template_list: async (args) => {
    const { status } = args as { status?: string };
    const qs = status ? `?status=${encodeURIComponent(status)}` : '';
    return okText(await call('agent', `/v1/templates${qs}`, 'GET'));
  },
  lsp_agent_template_get: async (args) => {
    const { template_key } = args as { template_key: string };
    return okText(await call('agent', `/v1/templates/${encodeURIComponent(template_key)}`, 'GET'));
  },
  lsp_agent_template_write: async (args) => {
    const { template_key, ...rest } = args as { template_key: string } & Record<string, unknown>;
    try {
      return okText(await call('agent', '/v1/templates', 'POST', { template_key, ...rest }));
    } catch (err) {
      if (err instanceof Error && err.message.includes('409')) {
        return okText(await call('agent', `/v1/templates/${encodeURIComponent(template_key)}`, 'PUT', rest));
      }
      throw err;
    }
  },
  lsp_agent_template_instantiate: async (args) => {
    const { template_key, ...rest } = args as { template_key: string } & Record<string, unknown>;
    return okText(await call('agent', `/v1/templates/${encodeURIComponent(template_key)}/instantiate`, 'POST', rest));
  },
};
