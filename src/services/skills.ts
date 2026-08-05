// -- ClaudeCode: Skills MCP tools. Tenant-scoped registry of versioned agent
// skills (LifeSpace_Skills_Spec.md, frozen 2026-07-01).
// Real routes (verified against Skills/src/routes/*):
//   POST /v1/skills            — create draft
//   GET  /v1/skills            — tenant-scoped summary list
//   GET  /v1/skills/:key       — working row; ?version=N | ?version=latest
//   PUT  /v1/skills/:key       — edit working row
//   POST /v1/skills/:key/publish — freeze immutable version
//   GET  /v1/search            — ILIKE over key/name/trigger/description + tag
//   POST /v1/resolve           — bodies + required_tools union (the Agent seam)
import type { ToolDef, ToolHandler } from '../types.js';
import { call, okText } from '../client.js';

export const tools: ToolDef[] = [
  {
    name: 'lsp_skills_search',
    description:
      "Search the tenant's skill registry by trigger text. Use when the user says 'is there a skill for X', 'find a skill', or before writing a procedure that may already exist. Matches skill_key/name/trigger/description (ILIKE) and optional tag; active skills only. Defaults to THIS tenant's own skills; set include_inherited=true to also search ancestor tenants — inherited skills appear only when include_inherited=true and only if flagged shared by their owner (each such row carries inherited=true + origin_tenant_id). q supports % wildcards: 'cs-prod%' = starts-with, '%data%table%' = ordered contains; no % = plain contains. Response includes total (full match count) and has_more; when has_more=true, paginate (raise limit) before concluding a skill is absent — a partial page is NOT the whole match set.",
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: "Search text matched against key, name, trigger, description. Include % for wildcard patterns ('cs-prod%', '%data%table%')." },
        tag: { type: 'string', description: 'Filter to skills carrying this tag.' },
        limit: { type: 'number', description: 'Max results (default 200, max 500).' },
        include_inherited: { type: 'boolean', description: 'Also search ancestor tenants. Inherited skills appear only when true AND only if their owner flagged them shared. Default false (own tenant only).' },
      },
    },
  },
  {
    name: 'lsp_skills_get',
    description:
      "Fetch one skill including its SKILL.md body. Accepts 'skill_key' (working row), 'skill_key@N' (pinned published version), or 'skill_key@latest' (highest published).",
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: "Skill ref: 'my-skill', 'my-skill@3', or 'my-skill@latest'." },
      },
      required: ['ref'],
    },
  },
  {
    name: 'lsp_skills_write',
    description:
      "Create or update a DRAFT skill (does not touch published versions — call lsp_skills_publish to freeze). Use when the user says 'save this as a skill', 'promote this procedure to a skill', 'update the X skill'. Body is SKILL.md markdown; trigger is the short 'use when…' text; required_tools lists LSP module ids the skill needs (e.g. ['dispatch','projects']).",
    inputSchema: {
      type: 'object',
      properties: {
        skill_key: { type: 'string', description: 'Slug, unique per tenant (a-z 0-9 -).' },
        name: { type: 'string', description: 'Human-readable name.' },
        description: { type: 'string', description: 'Optional longer description.' },
        trigger: { type: 'string', description: "Short 'use when…' text — drives search and SKILL.md description." },
        body: { type: 'string', description: 'SKILL.md markdown procedure.' },
        required_tools: { type: 'array', items: { type: 'string' }, description: 'LSP module ids this skill needs.' },
        tags: { type: 'array', items: { type: 'string' } },
        // ClaudeCode 2026-08-05 01:11 PM PDT
        signatures: {
          type: 'array',
          description:
            "Optional. Match this skill on FACTS in the caller's structured payload instead of word overlap with the trigger — a signature match outranks every lexical match. Each entry is a list of predicates ({path, op, value}) or {label, predicates}; ALL predicates in a signature must hold. op is 'eq' | 'exists' | 'contains'; path is a dot path into the payload and traverses arrays, e.g. 'csd_marks.marks.anchors.tag'. Example: [{\"label\":\"marked link\",\"predicates\":[{\"path\":\"csd_marks.marks.anchors.tag\",\"op\":\"eq\",\"value\":\"a\"},{\"path\":\"csd_marks.pageUrl\",\"op\":\"exists\"}]}]. Send [] to clear.",
          items: { type: 'object' },
        },
        source: {
          type: 'string',
          enum: ['authored', 'promoted_from_session', 'imported', 'platform'],
          description: "Provenance. Use 'promoted_from_session' when promoting something this session just solved.",
        },
      },
      required: ['skill_key'],
    },
  },
  {
    name: 'lsp_skills_publish',
    description:
      "Publish a skill: freeze the current working row into an immutable version and bump current_version. Consumers pin skill_key@version. Use after lsp_skills_write when the user says 'publish it', 'lock it in', 'make it official'.",
    inputSchema: {
      type: 'object',
      properties: {
        skill_key: { type: 'string' },
        change_note: { type: 'string', description: 'What changed since the previous version.' },
      },
      required: ['skill_key'],
    },
  },
  {
    name: 'lsp_skills_list',
    description:
      "List the tenant's skills (summary rows, no bodies). Defaults to THIS tenant's own skills; set include_inherited=true to also list skills inherited from ancestor tenants (nearest wins on key collisions). Inherited skills appear only when include_inherited=true and only if flagged shared by their owner — each such row carries inherited=true + origin_tenant_id. Every row carries shared (whether THIS tenant shares it downward). Filter by status (draft|active|archived) or tag. Response includes total (full count) and has_more; when has_more=true, paginate with offset (or raise limit) to see the whole catalog before concluding a skill isn't present — the default page is NOT necessarily the full registry.",
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['draft', 'active', 'archived'] },
        tag: { type: 'string' },
        limit: { type: 'number', description: 'Max results (default 200, max 500).' },
        offset: { type: 'number', description: 'Pagination offset; combine with has_more from the response.' },
        include_inherited: { type: 'boolean', description: 'Also list skills inherited from ancestor tenants. They appear only when true AND only if their owner flagged them shared. Default false (own tenant only).' },
      },
    },
  },
];

function splitRef(ref: string): { key: string; version?: string } {
  const at = ref.lastIndexOf('@');
  if (at <= 0) return { key: ref };
  return { key: ref.slice(0, at), version: ref.slice(at + 1) };
}

export const handlers: Record<string, ToolHandler> = {
  lsp_skills_search: async (args) => {
    const { q, tag, limit, include_inherited } = args as { q?: string; tag?: string; limit?: number; include_inherited?: boolean };
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (tag) params.set('tag', tag);
    if (limit) params.set('limit', String(limit));
    if (include_inherited) params.set('include_inherited', 'true');
    return okText(await call('skills', `/v1/search?${params.toString()}`, 'GET'));
  },
  lsp_skills_get: async (args) => {
    const { ref } = args as { ref: string };
    const { key, version } = splitRef(ref);
    const qs = version ? `?version=${encodeURIComponent(version)}` : '';
    return okText(await call('skills', `/v1/skills/${encodeURIComponent(key)}${qs}`, 'GET'));
  },
  lsp_skills_write: async (args) => {
    const { skill_key, ...rest } = args as { skill_key: string } & Record<string, unknown>;
    // Create-or-update: POST first; on the 409 duplicate, PUT the working row.
    try {
      return okText(await call('skills', '/v1/skills', 'POST', { skill_key, ...rest }));
    } catch (err) {
      if (err instanceof Error && err.message.includes('409')) {
        return okText(await call('skills', `/v1/skills/${encodeURIComponent(skill_key)}`, 'PUT', rest));
      }
      throw err;
    }
  },
  lsp_skills_publish: async (args) => {
    const { skill_key, change_note } = args as { skill_key: string; change_note?: string };
    return okText(await call('skills', `/v1/skills/${encodeURIComponent(skill_key)}/publish`, 'POST', { change_note }));
  },
  lsp_skills_list: async (args) => {
    const { status, tag, limit, offset, include_inherited } = args as { status?: string; tag?: string; limit?: number; offset?: number; include_inherited?: boolean };
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (tag) params.set('tag', tag);
    if (limit) params.set('limit', String(limit));
    if (offset) params.set('offset', String(offset));
    if (include_inherited) params.set('include_inherited', 'true');
    const qs = params.toString();
    return okText(await call('skills', `/v1/skills${qs ? `?${qs}` : ''}`, 'GET'));
  },
};
