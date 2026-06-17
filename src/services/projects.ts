// -- ClaudeCode: Projects MCP tools.
// Real routes (verified 2026-05-12 against Projects/src/routes/projects.ts):
//   Projects:
//     GET    /v1/projects                         — list
//     POST   /v1/projects                         — create { name, description?, status?, custom_field_defs?, status_defs?, apply_status_template? }
//     GET    /v1/projects/:id                     — get one
//     PATCH  /v1/projects/:id                     — update (name/description/status/custom_field_defs/status_defs)
//     DELETE /v1/projects/:id                     — soft-delete
//   Sections (one level, nested under project):
//     POST   /v1/projects/:projectId/sections     — create
//     PATCH  /v1/projects/:projectId/sections/:id — update
//     DELETE /v1/projects/:projectId/sections/:id — soft-delete
//   Tasks (nested under project; sub-tasks via parent_id, two levels max):
//     GET    /v1/projects/:projectId/tasks        — list (filters: section_id, status, assignee)
//     POST   /v1/projects/:projectId/tasks        — create
//     GET    /v1/projects/:projectId/tasks/:id    — get
//     PATCH  /v1/projects/:projectId/tasks/:id    — update
//     DELETE /v1/projects/:projectId/tasks/:id    — delete
//   Members (humans by email, agents by tenant UUID):
//     POST   /v1/projects/:projectId/members      — add
//     PATCH  /v1/projects/:projectId/members/:id  — role + active flag
//     DELETE /v1/projects/:projectId/members/:id  — remove
//   Notes (append-only): POST/GET under :projectId
//   Sprint Handoff: POST /v1/projects/:projectId/sprint — forwards to Handoff /v1/packets
import type { ToolDef, ToolHandler } from '../types.js';
import { call, okText } from '../client.js';

export const tools: ToolDef[] = [
  {
    name: 'lsp_projects_list',
    description: "List projects the caller has access to.",
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number' },
        offset: { type: 'number' },
        status: { type: 'string' },
        include_deleted: { type: 'boolean' },
      },
    },
  },
  {
    name: 'lsp_projects_get',
    description: 'Fetch a single project by id.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        expand: { type: 'string', description: "Comma-separated: 'sections,members,notes'." },
      },
      required: ['id'],
    },
  },
  {
    name: 'lsp_projects_create',
    description: "Create a new project. Use when the user says 'create a project for X', 'new project called Y'.",
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        status: { type: 'string' },
        custom_field_defs: { type: 'array', items: { type: 'object', additionalProperties: true } },
      },
      required: ['name'],
    },
  },
  {
    name: 'lsp_projects_task_list',
    description:
      "List tasks inside a specific project. project_id is REQUIRED — tasks are always project-scoped.",
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        section_id: { type: 'string' },
        status: { type: 'string' },
        assignee: { type: 'string' },
        include_deleted: { type: 'boolean' },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'lsp_projects_task_create',
    description:
      "Create a task (or sub-task) inside a project. Use when the user says 'add a task', 'on the list', 'track this', 'TODO this'. project_id is REQUIRED — if unclear, ask the user which project (call lsp_projects_list first). To create a sub-task, pass parent_id (two-level max). Sub-tasks created here are first-class tasks with full status/priority/due_at/assignee — for a strict checklist (title-only), call POST /tasks/:taskId/subtasks via curl instead.",
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        section_id: { type: 'string' },
        parent_id: {
          type: 'string',
          description: 'UUID of parent task to make this a sub-task. Two levels max — parent must itself be a root task.',
        },
        status: {
          type: 'string',
          description: "Status id from project.status_defs, or built-in 'open'|'in_progress'|'done'|'cancelled' if no custom statuses defined.",
        },
        priority: { type: 'string', description: "'low' | 'normal' | 'high' | 'urgent'" },
        assignee_user_id: { type: 'string', description: 'Email (human) or tenant UUID (agent).' },
        ref_url: { type: 'string', description: 'Primary external URL the task is about.' },
        due_at: { type: 'string', description: 'ISO 8601 timestamp.' },
        source: { type: 'string', description: "'human' | 'ai_agent' | 'ai_cleanup' | 'ai' | 'system'. Defaults to 'human'." },
        batch_id: { type: 'string', description: 'UUID grouping related writes from one run.' },
        custom_fields: { type: 'object', description: 'Values keyed by project.custom_field_defs[i].name.' },
      },
      required: ['project_id', 'title'],
    },
  },
  {
    name: 'lsp_projects_task_get',
    description: 'Get a single task by id within a project.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        id: { type: 'string' },
        expand: { type: 'string' },
      },
      required: ['project_id', 'id'],
    },
  },
  {
    name: 'lsp_projects_task_update',
    description:
      'Update a task — any field optional. Setting status to a value whose semantic type is done/cancelled cascades to all sub-tasks. Set parent_id to null to promote a sub-task to a root task.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        id: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        status: { type: 'string', description: "Status id from project.status_defs, or built-in 'open'|'in_progress'|'done'|'cancelled'." },
        priority: { type: 'string' },
        section_id: { type: 'string' },
        parent_id: { type: ['string', 'null'], description: 'Set to null to promote a sub-task to a root task.' },
        assignee_user_id: { type: 'string' },
        ref_url: { type: ['string', 'null'] },
        due_at: { type: ['string', 'null'] },
        sort_order: { type: 'number' },
        source: { type: 'string' },
        custom_fields: { type: 'object' },
      },
      required: ['project_id', 'id'],
    },
  },
  {
    name: 'lsp_projects_update',
    description:
      "Update a project's name / description / status / status_defs / custom_field_defs. Primary-tenant only (backend enforces). Use when the user says 'rename the project', 'update the description', 'add a status', 'add a custom field'. Status_defs entries each carry an `id` + `name` + `color` + `type` (one of: open | in_progress | ai_pending | pending | done | cancelled). custom_field_defs is the full replacement array (max 5 entries).",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        status: { type: 'string', description: "'active' | 'archived' | 'draft'" },
        status_defs: {
          type: 'array',
          description: 'Full replacement array. Each entry: { id, name, color, type }. Type ∈ open | in_progress | ai_pending | pending | done | cancelled.',
          items: { type: 'object', additionalProperties: true },
        },
        custom_field_defs: {
          type: 'array',
          description: 'Full replacement array (max 5). Each entry: { name, type, options? }.',
          items: { type: 'object', additionalProperties: true },
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'lsp_projects_section_create',
    description:
      "Create a section inside a project. Sections are one level deep; tasks belong to either a section or no section. Use when the user says 'add a section', 'create a phase/milestone' (sections are the canonical place for those).",
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        name: { type: 'string' },
        sort_order: { type: 'number', description: 'Lower = earlier. Default 0.' },
        start_date: { type: 'string', description: 'ISO 8601 — used for section-range warning on tasks with due dates outside.' },
        end_date: { type: 'string', description: 'ISO 8601.' },
      },
      required: ['project_id', 'name'],
    },
  },
  {
    name: 'lsp_projects_section_update',
    description:
      "Update a section — name / sort_order / date range. Pass null to clear a date.",
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        id: { type: 'string' },
        name: { type: 'string' },
        sort_order: { type: 'number' },
        start_date: { type: ['string', 'null'] },
        end_date: { type: ['string', 'null'] },
      },
      required: ['project_id', 'id'],
    },
  },
  {
    name: 'lsp_projects_section_delete',
    description:
      "Soft-delete a section. Tasks belonging to the section are NOT deleted — they remain on the project (their section_id will still reference the deleted row, so callers should set section_id=null on those tasks separately if desired).",
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        id: { type: 'string' },
      },
      required: ['project_id', 'id'],
    },
  },
  {
    name: 'lsp_projects_member_add',
    description:
      "Add a member to a project. user_id is the principal: email for humans (e.g. 'jane@example.com'), tenant UUID for agents. principal_type is auto-inferred from shape unless overridden. Role: 'owner' | 'member' | 'viewer' (default 'member'). Viewers are read-only.",
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        user_id: { type: 'string', description: 'Email (human) OR tenant UUID (agent).' },
        role: { type: 'string', description: "'owner' | 'member' | 'viewer'. Default 'member'." },
        principal_type: { type: 'string', enum: ['user', 'agent'], description: "Auto-inferred from user_id shape (UUID → 'agent', else 'user')." },
      },
      required: ['project_id', 'user_id'],
    },
  },
  {
    name: 'lsp_projects_member_update',
    description:
      "Update a member's role or active flag. Use active=false to soft-deactivate without removing the row.",
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        id: { type: 'string', description: 'Member row UUID (NOT user_id).' },
        role: { type: 'string', description: "'owner' | 'member' | 'viewer'" },
        active: { type: 'boolean' },
      },
      required: ['project_id', 'id'],
    },
  },
  {
    name: 'lsp_projects_member_remove',
    description:
      "Hard-delete a member row. For soft-deactivate, use lsp_projects_member_update with active=false instead.",
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        id: { type: 'string', description: 'Member row UUID (NOT user_id).' },
      },
      required: ['project_id', 'id'],
    },
  },
  {
    name: 'lsp_projects_note_add',
    description:
      "Append a note (threaded, immutable) to a project or a specific task. Notes are the canonical place for append-only updates and context.",
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        body: { type: 'string' },
        task_id: { type: 'string', description: 'If set, the note attaches to this task.' },
        source: { type: 'string' },
      },
      required: ['project_id', 'body'],
    },
  },
  {
    name: 'lsp_projects_notes_list',
    description: "List notes on a project (includes task notes if include_task_notes=true).",
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        include_task_notes: { type: 'boolean' },
      },
      required: ['project_id'],
    },
  },
];

function qs(obj: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    parts.push(`${k}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

export const handlers: Record<string, ToolHandler> = {
  lsp_projects_list: async (args) => {
    const q = qs((args ?? {}) as Record<string, unknown>);
    return okText(await call('projects', `/v1/projects${q}`, 'GET'));
  },
  lsp_projects_get: async (args) => {
    const { id, expand } = args as { id: string; expand?: string };
    const q = expand ? `?expand=${encodeURIComponent(expand)}` : '';
    return okText(await call('projects', `/v1/projects/${id}${q}`, 'GET'));
  },
  lsp_projects_create: async (args) => okText(await call('projects', '/v1/projects', 'POST', args)),
  lsp_projects_task_list: async (args) => {
    const { project_id, ...rest } = args as Record<string, unknown> & { project_id: string };
    const q = qs(rest);
    return okText(await call('projects', `/v1/projects/${project_id}/tasks${q}`, 'GET'));
  },
  lsp_projects_task_create: async (args) => {
    const { project_id, ...body } = args as Record<string, unknown> & { project_id: string };
    return okText(await call('projects', `/v1/projects/${project_id}/tasks`, 'POST', body));
  },
  lsp_projects_task_get: async (args) => {
    const { project_id, id, expand } = args as {
      project_id: string;
      id: string;
      expand?: string;
    };
    const q = expand ? `?expand=${encodeURIComponent(expand)}` : '';
    return okText(await call('projects', `/v1/projects/${project_id}/tasks/${id}${q}`, 'GET'));
  },
  lsp_projects_task_update: async (args) => {
    const { project_id, id, ...body } = args as Record<string, unknown> & {
      project_id: string;
      id: string;
    };
    return okText(await call('projects', `/v1/projects/${project_id}/tasks/${id}`, 'PATCH', body));
  },
  lsp_projects_note_add: async (args) => {
    const { project_id, ...body } = args as Record<string, unknown> & { project_id: string };
    return okText(await call('projects', `/v1/projects/${project_id}/notes`, 'POST', body));
  },
  lsp_projects_notes_list: async (args) => {
    const { project_id, include_task_notes } = args as {
      project_id: string;
      include_task_notes?: boolean;
    };
    const q = include_task_notes ? '?include_task_notes=true' : '';
    return okText(await call('projects', `/v1/projects/${project_id}/notes${q}`, 'GET'));
  },
  lsp_projects_update: async (args) => {
    const { id, ...body } = args as Record<string, unknown> & { id: string };
    return okText(await call('projects', `/v1/projects/${id}`, 'PATCH', body));
  },
  lsp_projects_section_create: async (args) => {
    const { project_id, ...body } = args as Record<string, unknown> & { project_id: string };
    return okText(await call('projects', `/v1/projects/${project_id}/sections`, 'POST', body));
  },
  lsp_projects_section_update: async (args) => {
    const { project_id, id, ...body } = args as Record<string, unknown> & { project_id: string; id: string };
    return okText(await call('projects', `/v1/projects/${project_id}/sections/${id}`, 'PATCH', body));
  },
  lsp_projects_section_delete: async (args) => {
    const { project_id, id } = args as { project_id: string; id: string };
    return okText(await call('projects', `/v1/projects/${project_id}/sections/${id}`, 'DELETE'));
  },
  lsp_projects_member_add: async (args) => {
    const { project_id, ...body } = args as Record<string, unknown> & { project_id: string };
    return okText(await call('projects', `/v1/projects/${project_id}/members`, 'POST', body));
  },
  lsp_projects_member_update: async (args) => {
    const { project_id, id, ...body } = args as Record<string, unknown> & { project_id: string; id: string };
    return okText(await call('projects', `/v1/projects/${project_id}/members/${id}`, 'PATCH', body));
  },
  lsp_projects_member_remove: async (args) => {
    const { project_id, id } = args as { project_id: string; id: string };
    return okText(await call('projects', `/v1/projects/${project_id}/members/${id}`, 'DELETE'));
  },
};
