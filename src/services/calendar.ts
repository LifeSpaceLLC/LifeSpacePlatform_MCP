// -- ClaudeCode: Calendar MCP tools. Wraps the Calendar service REST API —
// the "talk to the calendar" surface (list/create/update/delete events,
// list calendars + connections + subjects, custody, coverage gaps).
import type { ToolDef, ToolHandler } from '../types.js';
import { call, okText } from '../client.js';

export const tools: ToolDef[] = [
  {
    name: 'lsp_calendar_list_calendars',
    description:
      "List the tenant's calendars across all connected Google accounts. Each shows role ('book' = 2-way read-write, 'block' = conflicts-only/read-only), whether it's the default, and which connection it belongs to. Use for 'what calendars do I have', 'show my calendars'.",
    inputSchema: {
      type: 'object',
      properties: {
        connection_id: { type: 'string', description: 'Optional — limit to one connected account.' },
      },
    },
  },
  {
    name: 'lsp_calendar_list_connections',
    description:
      "List connected Google accounts for the tenant (email + status). Use for 'which accounts are connected', 'is my calendar connected'. To connect a new account, call lsp_calendar_get_connect_url.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'lsp_calendar_get_connect_url',
    description:
      "Get a Google consent URL the user opens to connect a Google account (one-click 'Connect Google Calendar'). Returns { auth_url }. Use when the user wants to connect/add a calendar account.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'lsp_calendar_list_events',
    description:
      "List calendar events in a date range, optionally for one calendar or one subject (e.g. a child). Use for 'what's on the calendar', 'what does Ari have this week', 'show events Tuesday'.",
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'ISO start of range (e.g. 2026-05-22T00:00:00Z).' },
        to: { type: 'string', description: 'ISO end of range.' },
        calendar_id: { type: 'string', description: 'Optional — limit to one calendar.' },
        subject_id: { type: 'string', description: 'Optional — limit to events about one subject (kid/pet/elder).' },
      },
    },
  },
  {
    name: 'lsp_calendar_create_event',
    description:
      "Create an event. Writes through to Google on a connected 'book' calendar (tagged as AI-created so it never clobbers manual entries). Use for 'add to the calendar', 'schedule X', 'put the dentist appt on Tuesday', or when extracting an event from an email.",
    inputSchema: {
      type: 'object',
      properties: {
        calendar_id: { type: 'string', description: 'Target calendar id (use the default book calendar if unspecified by the user).' },
        title: { type: 'string' },
        description: { type: 'string' },
        location: { type: 'string' },
        starts_at: { type: 'string', description: 'ISO datetime (or date for all-day).' },
        ends_at: { type: 'string', description: 'ISO datetime/date.' },
        all_day: { type: 'boolean' },
        busy: { type: 'boolean', description: 'Default true. Set FALSE for informational/covered events that should NOT block bookable time (avoids double-book with scheduling tools).' },
        color_id: { type: 'string', description: "Optional Google event color ('1'..'11') — e.g. to color-code per person/category." },
        subject_id: { type: 'string', description: 'Optional — the subject this event is about (kid/pet/elder).' },
        source: { type: 'string', enum: ['manual', 'email_ingest', 'sync'], description: "Where it came from. Use 'email_ingest' when created from a parsed email." },
      },
      required: ['calendar_id', 'title'],
    },
  },
  {
    name: 'lsp_calendar_create_subject',
    description:
      "Create a subject the schedule is ABOUT — a child, pet, or elder (e.g. Ari, Miro). Required before custody + coverage-gap detection can run. Use for 'add Ari', 'track my son', 'set up the kids'.",
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['child', 'pet', 'elder', 'self', 'other'] },
        name: { type: 'string' },
        dob: { type: 'string', description: 'Optional YYYY-MM-DD — drives age-appropriate handling.' },
        attributes: { type: 'object', description: 'Optional: school, grade, activities, roster, etc.', additionalProperties: true },
      },
      required: ['kind', 'name'],
    },
  },
  {
    name: 'lsp_calendar_share_calendar',
    description:
      "Share a calendar with another person's Google account so it appears in their Google Calendar (e.g. share 'Ari's World - Shared' with a co-parent). Use for 'share with Sherry', 'give my wife access'.",
    inputSchema: {
      type: 'object',
      properties: {
        calendar_id: { type: 'string' },
        email: { type: 'string', description: "The person's email to share with." },
        role: { type: 'string', enum: ['writer', 'reader'], description: "Default 'writer' (can add/edit); 'reader' = view only." },
      },
      required: ['calendar_id', 'email'],
    },
  },
  {
    name: 'lsp_calendar_update_event',
    description: 'Update an existing event (syncs the change through to Google if connected). Use for reschedule/rename/relocate.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Event id.' },
        title: { type: 'string' }, description: { type: 'string' }, location: { type: 'string' },
        starts_at: { type: 'string' }, ends_at: { type: 'string' }, all_day: { type: 'boolean' }, status: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'lsp_calendar_delete_event',
    description: 'Delete an event (also removes it from Google if connected).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'lsp_calendar_list_subjects',
    description: "List subjects — the people/pets/elders the schedule is about (e.g. a child). Use for 'who's tracked', and to get a subject_id for events/custody/coverage.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'lsp_calendar_set_custody',
    description:
      "Set who is responsible for a subject, when. 'recurring' rows are the standing pattern (e.g. Greg covers Mon-Thu); 'override' rows are one-off changes for a date range. Powers coverage-gap detection. Use for 'I have Ari Mon-Wed', 'Sherry has him this weekend'.",
    inputSchema: {
      type: 'object',
      properties: {
        subject_id: { type: 'string' },
        responsible_name: { type: 'string', description: 'Who is responsible (e.g. "Greg").' },
        kind: { type: 'string', enum: ['recurring', 'override'], description: "Default 'recurring'." },
        pattern: { type: 'object', description: 'For recurring: { days: ["mon","tue","wed"] }.', additionalProperties: true },
        starts_at: { type: 'string', description: 'For override: ISO start of the covered window.' },
        ends_at: { type: 'string', description: 'For override: ISO end.' },
      },
      required: ['subject_id', 'responsible_name'],
    },
  },
  {
    name: 'lsp_calendar_get_coverage',
    description:
      "List open coverage gaps — days/blocks where a subject (e.g. a child) needs supervision but no one is assigned (the dropped-ball alerts). Use for 'are there any coverage gaps', 'who has Ari Friday', 'is anyone watching the kids next week'.",
    inputSchema: {
      type: 'object',
      properties: {
        subject_id: { type: 'string' },
        from: { type: 'string' }, to: { type: 'string' },
        status: { type: 'string', enum: ['open', 'dismissed', 'resolved'], description: "Default 'open'." },
      },
    },
  },
  {
    name: 'lsp_calendar_scan_coverage',
    description:
      'Run the coverage engine for a subject over a date range — finds needs-coverage days (school closures, activities) with no responsible adult and raises alerts. Use after adding events/custody, or to proactively check ahead.',
    inputSchema: {
      type: 'object',
      properties: {
        subject_id: { type: 'string' },
        from: { type: 'string', description: 'ISO start.' },
        to: { type: 'string', description: 'ISO end.' },
      },
      required: ['subject_id', 'from', 'to'],
    },
  },
];

export const handlers: Record<string, ToolHandler> = {
  lsp_calendar_list_calendars: async (args) => {
    const cid = (args as { connection_id?: string } | undefined)?.connection_id;
    return okText(await call('calendar', `/v1/calendars${cid ? `?connection_id=${cid}` : ''}`, 'GET'));
  },
  lsp_calendar_list_connections: async () => okText(await call('calendar', '/v1/connections', 'GET')),
  lsp_calendar_get_connect_url: async () => okText(await call('calendar', '/v1/oauth/google/start', 'GET')),
  lsp_calendar_list_events: async (args) => {
    const qs = new URLSearchParams(args as Record<string, string>).toString();
    return okText(await call('calendar', `/v1/events${qs ? `?${qs}` : ''}`, 'GET'));
  },
  lsp_calendar_create_event: async (args) => okText(await call('calendar', '/v1/events', 'POST', args)),
  lsp_calendar_update_event: async (args) => {
    const { id, ...body } = args as { id: string } & Record<string, unknown>;
    return okText(await call('calendar', `/v1/events/${id}`, 'PATCH', body));
  },
  lsp_calendar_delete_event: async (args) => {
    const { id } = args as { id: string };
    return okText(await call('calendar', `/v1/events/${id}`, 'DELETE'));
  },
  lsp_calendar_list_subjects: async () => okText(await call('calendar', '/v1/subjects', 'GET')),
  lsp_calendar_create_subject: async (args) => okText(await call('calendar', '/v1/subjects', 'POST', args)),
  lsp_calendar_share_calendar: async (args) => {
    const { calendar_id, ...body } = args as { calendar_id: string } & Record<string, unknown>;
    return okText(await call('calendar', `/v1/calendars/${calendar_id}/share`, 'POST', body));
  },
  lsp_calendar_set_custody: async (args) => okText(await call('calendar', '/v1/custody', 'POST', args)),
  lsp_calendar_get_coverage: async (args) => {
    const qs = new URLSearchParams({ status: 'open', ...(args as Record<string, string>) }).toString();
    return okText(await call('calendar', `/v1/coverage?${qs}`, 'GET'));
  },
  lsp_calendar_scan_coverage: async (args) => okText(await call('calendar', '/v1/coverage/scan', 'POST', args)),
};
