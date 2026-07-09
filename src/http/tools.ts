// -- ClaudeCode (2026-07-08): Tool aggregation + module-scoped filtering for the
// HTTP transport. SAME modules the stdio server registers (zero tool drift by
// construction — D1). tools/list is filtered by the caller's JWT `modules`
// claim; admin/super_admin/tenant_admin see everything (D6). Enforcement still
// lives in each backing service (403) — this filter is UX, the 403 is security.
import * as dispatch from '../services/dispatch.js';
import * as keys from '../services/keys.js';
import * as memory from '../services/memory.js';
import * as knowledge from '../services/knowledge.js';
import * as projects from '../services/projects.js';
import * as library from '../services/library.js';
import * as tenant from '../services/tenant.js';
import * as trust from '../services/trust.js';
import * as handoff from '../services/handoff.js';
import * as promote from '../services/promote.js';
import * as capture from '../services/capture.js';
import * as canvas from '../services/canvas.js';
import * as calendar from '../services/calendar.js';
import * as assistant from '../services/assistant.js';
import * as listen from '../services/listen.js';
import * as skills from '../services/skills.js';
import * as agent from '../services/agent.js';
import * as flow from '../services/flow.js';
import type { ToolDef, ToolHandler } from '../types.js';

// -- ClaudeCode: (module id, tools, handlers). The id MUST match the module id
// carried in the JWT `modules` claim (Admin/src/modules/catalog.ts + each
// service's role=user gate). Keep this list in lockstep with server.ts.
const MODULES: Array<{ id: string; mod: { tools: ToolDef[]; handlers: Record<string, ToolHandler> } }> = [
  { id: 'dispatch', mod: dispatch },
  { id: 'keys', mod: keys },
  { id: 'memory', mod: memory },
  { id: 'knowledge', mod: knowledge },
  { id: 'projects', mod: projects },
  { id: 'library', mod: library },
  { id: 'tenant', mod: tenant },
  { id: 'trust', mod: trust },
  { id: 'handoff', mod: handoff },
  { id: 'promote', mod: promote },
  { id: 'capture', mod: capture },
  { id: 'canvas', mod: canvas },
  { id: 'calendar', mod: calendar },
  { id: 'assistant', mod: assistant },
  { id: 'listen', mod: listen },
  { id: 'skills', mod: skills },
  { id: 'agent', mod: agent },
  { id: 'flow', mod: flow },
];

export const allTools: ToolDef[] = MODULES.flatMap((m) => m.mod.tools);
export const allHandlers: Record<string, ToolHandler> = Object.assign(
  {},
  ...MODULES.map((m) => m.mod.handlers),
);

// toolName → module id, for filtering + belt-and-suspenders call gating.
export const TOOL_MODULE: Record<string, string> = Object.fromEntries(
  MODULES.flatMap((m) => m.mod.tools.map((t) => [t.name, m.id] as const)),
);

export interface CallerClaims {
  role?: string;
  modules?: string[] | null;
}

/** admin/super_admin/tenant_admin (i.e. anyone who is NOT a plain 'user') see
 *  every tool. role='user' sees only tools whose module is granted. */
export function seesAllModules(claims: CallerClaims): boolean {
  return claims.role !== 'user';
}

export function toolsForClaims(claims: CallerClaims): ToolDef[] {
  if (seesAllModules(claims)) return allTools;
  const granted = new Set(claims.modules ?? []);
  return allTools.filter((t) => granted.has(TOOL_MODULE[t.name]));
}

/** Is this tool callable by the caller? Mirrors toolsForClaims for CallTool. */
export function canCallTool(name: string, claims: CallerClaims): boolean {
  if (seesAllModules(claims)) return true;
  const granted = new Set(claims.modules ?? []);
  return granted.has(TOOL_MODULE[name]);
}

// -- ClaudeCode (D7): the `agent` prompt. Connector prompts surface as slash
// commands in Cowork/Claude chat. This is how a teammate gets `/agent` with zero
// install beyond adding the connector.
export const AGENT_PROMPT_NAME = 'agent';

export const AGENT_PROMPT = {
  name: AGENT_PROMPT_NAME,
  description:
    'Hand a plain-English task to your LifeSpace agent. It drafts a plan, you approve, it runs the work.',
  arguments: [
    {
      name: 'request',
      description: 'What you want done, in plain English (e.g. "pull last week\'s call notes from Grain and summarize them").',
      required: false,
    },
  ],
};

export function agentPromptMessages(request?: string): Array<{ role: 'user'; content: { type: 'text'; text: string } }> {
  const task = request?.trim()
    ? `The user's request:\n\n${request.trim()}`
    : 'Ask the user what they want done, in one short question.';
  return [
    {
      role: 'user',
      content: {
        type: 'text',
        text: `You are the LifeSpace agent front door. Take the user's plain-English request and route it through the agent queue:

1. Call \`lsp_agent_compose\` with the request to draft an execution plan.
2. Show the user the plan in plain English — what will happen, what it will touch — and ask them to confirm.
3. On "yes", enqueue the work (\`lsp_agent_enqueue\`) and tell them it's running.
4. If compose flags the request as ambiguous or under-specified, ask a clarifying question. NEVER guess or invent scope.

${task}`,
      },
    },
  ];
}
