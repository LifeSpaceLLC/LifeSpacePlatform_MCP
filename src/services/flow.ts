// -- ClaudeCode (2026-07-06): Flow MCP tools. Wraps the Flow service REST API
// (LifeSpace_Flow_v1_Spec.md) — the "do a multi-step procedure" surface. Author
// a flow (declarative JSON graph), publish it (strict DAG validation), run it,
// and inspect runs. This is the run/read/author verb set the Agent seam and the
// test harness need to exercise flows end-to-end. Definitions are versioned +
// immutable once published (editing forks a new draft). Kept thin — the engine
// and validation live in the service, not here.
import type { ToolDef, ToolHandler } from '../types.js';
import { call, okText } from '../client.js';

export const tools: ToolDef[] = [
  {
    name: 'lsp_flow_list',
    description:
      "List the tenant's flows (latest version per flow_key) with status (draft/published/archived), name, and trigger. Use for 'what flows exist', 'what automations are built'.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'lsp_flow_get',
    description:
      "Get one flow by flow_key — returns all versions plus the latest. Includes the graph (trigger, vars, steps[]) so you can see what the flow actually does before running it.",
    inputSchema: {
      type: 'object',
      properties: {
        flow_key: { type: 'string', description: 'The flow slug (a-z 0-9 -).' },
        app_id: { type: 'string', description: 'Optional app scoping; omit for tenant-wide flows.' },
      },
      required: ['flow_key'],
    },
  },
  {
    name: 'lsp_flow_write',
    description:
      "Create or update a flow draft. flow_key = lowercase slug (immutable identity). graph = the declarative JSON: { trigger:{type:'manual'|'listen.tag'|'cron', config}, vars?:{}, steps:[{ id, type, config, next }] }. A step's `next` is the id of the following step (or null to end; an array for fan-out). Control-flow steps: `branch` uses { cases:[{when,next}], else_next }; `for_each` uses { config:{items}, body:[childIds] }. Reference upstream data in any config value with ={{ steps.<id>.output.field }} / ={{ trigger.field }} (JMESPath). Query GET /v1/steps for the step-type catalog + each step's config + output shape. Updates the draft in place; forks a new version if the latest is published. Does NOT run — publish first, then run.",
    inputSchema: {
      type: 'object',
      properties: {
        flow_key: { type: 'string', description: 'Lowercase slug: a-z 0-9 - (immutable identity).' },
        name: { type: 'string', description: 'Human display name.' },
        description: { type: 'string' },
        graph: { type: 'object', description: 'Declarative flow graph: { trigger, vars?, steps:[{id,type,config,next}] }. See the tool description for step shapes; ={{ steps.<id>.output.field }} to wire data.', additionalProperties: true },
        app_id: { type: 'string', description: 'Optional app scoping; omit for tenant-wide.' },
      },
      required: ['flow_key', 'name', 'graph'],
    },
  },
  {
    name: 'lsp_flow_publish',
    description:
      "Publish a flow's latest draft — runs full graph validation (the DAG/loop-viz guard) then registers its trigger (listen.tag or cron bind a trigger row; manual is invoked via lsp_flow_run). Immutable once published. Returns the published flow + any registered trigger.",
    inputSchema: {
      type: 'object',
      properties: {
        flow_key: { type: 'string' },
        app_id: { type: 'string', description: 'Optional app scoping; omit for tenant-wide.' },
      },
      required: ['flow_key'],
    },
  },
  {
    name: 'lsp_flow_run',
    description:
      "Manually run a published flow now (enqueues a run + nudges the sweeper so it starts immediately). input = the trigger payload the flow's steps map `={{ trigger.field }}` against. Returns the run (with its id) — poll lsp_flow_run_get for status/steps. Runs the latest published version unless `version` is given.",
    inputSchema: {
      type: 'object',
      properties: {
        flow_key: { type: 'string' },
        input: { type: 'object', description: 'Trigger payload for this run (matches the flow input contract).', additionalProperties: true },
        version: { type: 'number', description: 'Pin a specific version; omit for latest published.' },
        app_id: { type: 'string', description: 'Optional app scoping; omit for tenant-wide.' },
      },
      required: ['flow_key'],
    },
  },
  {
    name: 'lsp_flow_runs_list',
    description:
      "List recent flow runs with status (queued/running/succeeded/failed/waiting) and timing. Optional filters via query params (e.g. flow_key, status, limit). Use to see 'did my flow run', 'what's in flight'.",
    inputSchema: {
      type: 'object',
      properties: {
        flow_key: { type: 'string', description: 'Filter to one flow.' },
        status: { type: 'string', description: 'Filter by run status.' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'lsp_flow_run_get',
    description:
      "Get one flow run by id — terminal status + per-step input/output snapshots (the data that flowed through each node). This is how you verify a flow reached COMPLETED and what each seam produced. Poll after lsp_flow_run.",
    inputSchema: {
      type: 'object',
      properties: { run_id: { type: 'string', description: 'The run id from lsp_flow_run.' } },
      required: ['run_id'],
    },
  },
];

export const handlers: Record<string, ToolHandler> = {
  lsp_flow_list: async () => okText(await call('flow', '/v1/flows', 'GET')),
  lsp_flow_get: async (args) => {
    const { flow_key, app_id } = args as { flow_key: string; app_id?: string };
    const qs = app_id ? `?app_id=${encodeURIComponent(app_id)}` : '';
    return okText(await call('flow', `/v1/flows/${encodeURIComponent(flow_key)}${qs}`, 'GET'));
  },
  lsp_flow_write: async (args) => okText(await call('flow', '/v1/flows', 'POST', args)),
  lsp_flow_publish: async (args) => {
    const { flow_key, app_id } = args as { flow_key: string; app_id?: string };
    const qs = app_id ? `?app_id=${encodeURIComponent(app_id)}` : '';
    return okText(await call('flow', `/v1/flows/${encodeURIComponent(flow_key)}/publish${qs}`, 'POST', {}));
  },
  lsp_flow_run: async (args) => {
    const { flow_key, ...body } = args as { flow_key: string } & Record<string, unknown>;
    return okText(await call('flow', `/v1/flows/${encodeURIComponent(flow_key)}/run`, 'POST', body));
  },
  lsp_flow_runs_list: async (args) => {
    const qs = new URLSearchParams(args as Record<string, string>).toString();
    return okText(await call('flow', `/v1/runs${qs ? `?${qs}` : ''}`, 'GET'));
  },
  lsp_flow_run_get: async (args) => {
    const { run_id } = args as { run_id: string };
    return okText(await call('flow', `/v1/runs/${encodeURIComponent(run_id)}`, 'GET'));
  },
};
