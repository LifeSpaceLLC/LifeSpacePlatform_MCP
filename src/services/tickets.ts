// -- ClaudeCode (chunk 6): Tickets MCP tools. Tenant-scoped, AI-triaged support queue
// (LifeSpace_Tickets_Spec.md). This is what lets an AI actually WORK the queue —
// create tickets, see what's waiting, answer customers, and hand work to an agent.
//
// LINGO (Greg via Oracle, 2026-07-14): the units of the Agent queue are **agents**,
// never "agent tasks". Say "spawn an agent", "gated agent", "running agent".
//
// Real routes (verified against Tickets/src/routes/*):
//   GET  /v1/tickets                  — filtered queue (state/priority/assignee/category)
//   GET  /v1/tickets/:id?expand=messages — one ticket, optionally with its thread
//   POST /v1/tickets                  — create (auto-triages on arrival)
//   POST /v1/tickets/:id/messages     — append to the thread; public ⇒ emailed to the customer
//   POST /v1/tickets/:id/transitions  — state machine gate
//   POST /v1/tickets/:id/triage       — run/re-run AI triage
//   POST /v1/tickets/:id/spawn-agent  — hand the ticket to an agent (human-gated by default)
import type { ToolDef, ToolHandler } from '../types.js';
import { call, okText } from '../client.js';

export const tools: ToolDef[] = [
  {
    name: 'lsp_tickets_list',
    description:
      "List the tenant's support ticket queue. Use when the user says 'what tickets are open', 'anything waiting on me', 'flush the ticket queue', or before working support. Tickets are auto-triaged on arrival, so each carries an AI-written subject + one-line summary (ai_subject/ai_summary) — read those, not the raw email subject, which is often useless ('Notification', 'Fwd: …'). Filter by state to find work: 'open' = needs a human, 'escalated' = needs attention now, 'waiting_customer' = parked on a reply.",
    inputSchema: {
      type: 'object',
      properties: {
        state: {
          type: 'string',
          enum: [
            'created',
            'pending_triage',
            'open',
            'in_progress',
            'waiting_customer',
            'escalated',
            'resolved',
            'closed',
            'cancelled',
          ],
          description: 'Filter to one state. Omit for all.',
        },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
        assignee: { type: 'string', description: 'Filter by assignee (email, or "agent:<id>" when an agent owns it).' },
        category: { type: 'string', enum: ['bug', 'question', 'feature_request', 'account', 'other'] },
        limit: { type: 'number', description: 'Max results (default 50, max 200).' },
        offset: { type: 'number' },
      },
    },
  },
  {
    name: 'lsp_tickets_get',
    description:
      "Fetch one ticket. Set with_messages=true to get the whole conversation thread (public replies + internal notes, including AI triage notes). The ticket carries both the RAW email (subject/body_md — audit truth) and the AI-distilled versions (ai_subject/ai_summary/body_essence). Read body_essence to see what the person actually said with signatures, disclaimers and quoted history stripped; fall back to body_md if it's null.",
    inputSchema: {
      type: 'object',
      properties: {
        ticket_id: { type: 'string', description: 'Ticket UUID.' },
        with_messages: { type: 'boolean', description: 'Include the full conversation thread (default false).' },
      },
      required: ['ticket_id'],
    },
  },
  {
    name: 'lsp_tickets_create',
    description:
      "Open a support ticket. Use when the user reports a problem, asks for support, or says 'file a ticket'. AI triage runs automatically on creation — it classifies, prioritizes, writes a clear subject/summary, and may auto-answer from Knowledge — so do NOT call lsp_tickets_triage afterwards. Provide submitter_email when a real person is waiting on the answer: that's who gets emailed when someone replies publicly.",
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'What this is about.' },
        body_md: { type: 'string', description: 'The full request/problem, markdown.' },
        category: { type: 'string', enum: ['bug', 'question', 'feature_request', 'account', 'other'] },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'], description: 'Default normal.' },
        submitter_email: { type: 'string', description: "The requester's email — they receive public replies." },
        submitter_name: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        customer_label: {
          type: 'string',
          description:
            "Free-text 'who is this for' label — the customer/account/system this ticket belongs to (e.g. 'Realcomm', 'CS-Designer', 'Internal'). Shows as a chip in the queue. Omit for internal/unlabeled tickets.",
        },
        links: {
          type: 'array',
          description:
            'Typed links to other records this ticket relates to (label-only for now — no navigation). Use to stamp which customer/project/app/site/tenant this concerns.',
          items: {
            type: 'object',
            properties: {
              kind: {
                type: 'string',
                enum: ['customer', 'project', 'app', 'site', 'tenant', 'other'],
                description: 'What kind of record this links to. Unknown kinds are stored as "other".',
              },
              ref_id: { type: 'string', description: 'Optional id of the linked record (opaque — no cross-module lookup yet).' },
              label: { type: 'string', description: 'Human-readable label shown for the link (required).' },
            },
            required: ['kind', 'label'],
          },
        },
      },
      required: ['subject', 'body_md'],
    },
  },
  {
    name: 'lsp_tickets_reply',
    description:
      "Add a message to a ticket. visibility='public' EMAILS IT TO THE CUSTOMER (via Dispatch, with a tokened reply address so their reply lands back on this ticket) — treat that as sending real mail to a real person. visibility='internal' (the default) is a private note only the team sees. Optionally transition in the same call: send_and_close resolves the ticket, send_and_wait parks it on the customer.",
    inputSchema: {
      type: 'object',
      properties: {
        ticket_id: { type: 'string' },
        body_md: { type: 'string', description: 'The message. If public, this is what the customer reads.' },
        visibility: {
          type: 'string',
          enum: ['public', 'internal'],
          description: "'public' emails the customer. 'internal' (default) is a private note.",
        },
        send_and_close: { type: 'boolean', description: 'Resolve the ticket after posting.' },
        send_and_wait: { type: 'boolean', description: 'Move to waiting_customer after posting.' },
        cc: { type: 'array', items: { type: 'string' }, description: 'CC addresses (public replies only).' },
      },
      required: ['ticket_id', 'body_md'],
    },
  },
  {
    name: 'lsp_tickets_transition',
    description:
      "Move a ticket to a new state. Server-enforced state machine — an illegal move returns 400. Common: open→in_progress (picking it up), →resolved (fixed), →escalated (needs a human now), →closed (done, from resolved). A resolved ticket reopens automatically if the customer replies.",
    inputSchema: {
      type: 'object',
      properties: {
        ticket_id: { type: 'string' },
        to_state: {
          type: 'string',
          enum: [
            'pending_triage',
            'open',
            'in_progress',
            'waiting_customer',
            'escalated',
            'resolved',
            'closed',
            'cancelled',
          ],
        },
        reason: { type: 'string', description: 'Why — recorded on the ticket.' },
      },
      required: ['ticket_id', 'to_state'],
    },
  },
  {
    name: 'lsp_tickets_triage',
    description:
      "Re-run AI triage on an existing ticket (classify + prioritize + rewrite subject/summary/essence + draft a resolution from Knowledge/Memory). You rarely need this: triage runs automatically on creation and a sweep catches anything missed. Use it after the ticket's content changed materially, or to retry when triage failed and the ticket is stuck in pending_triage.",
    inputSchema: {
      type: 'object',
      properties: {
        ticket_id: { type: 'string' },
      },
      required: ['ticket_id'],
    },
  },
  {
    name: 'lsp_tickets_spawn_agent',
    description:
      "Hand a ticket to an AGENT to actually go do the work (fix the bug, research the answer). Composes an agent envelope from the ticket — subject, body, thread and all — and assigns the ticket to it. By default the agent is created GATED: it does not run until a human approves it (the tenant can opt into auto-start). When the agent finishes, its result posts back onto the ticket and the ticket moves to resolved (or escalates if it failed). Use when a ticket needs real work done rather than just an answer.",
    inputSchema: {
      type: 'object',
      properties: {
        ticket_id: { type: 'string' },
        intent: {
          type: 'string',
          enum: [
            'code_change',
            'content_task',
            'data_task',
            'research_task',
            'ops_task',
            'messaging_task',
            'custom',
          ],
          description: "Override the intent. Omit to derive it from the ticket's category.",
        },
        instructions: {
          type: 'string',
          description: 'Extra operator instructions for the agent, appended to the envelope.',
        },
        spawn_mode: {
          type: 'string',
          enum: ['approve_first', 'auto_start'],
          description:
            "Override the tenant default. 'approve_first' = the agent is gated until a human approves it (default). 'auto_start' = it goes straight into the queue.",
        },
      },
      required: ['ticket_id'],
    },
  },
];

export const handlers: Record<string, ToolHandler> = {
  lsp_tickets_list: async (args) => {
    const { state, priority, assignee, category, limit, offset } = args as Record<string, unknown>;
    const params = new URLSearchParams();
    if (state) params.set('state', String(state));
    if (priority) params.set('priority', String(priority));
    if (assignee) params.set('assignee', String(assignee));
    if (category) params.set('category', String(category));
    if (limit) params.set('limit', String(limit));
    if (offset) params.set('offset', String(offset));
    const qs = params.toString();
    return okText(await call('tickets', `/v1/tickets${qs ? `?${qs}` : ''}`, 'GET'));
  },

  lsp_tickets_get: async (args) => {
    const { ticket_id, with_messages } = args as { ticket_id: string; with_messages?: boolean };
    const qs = with_messages ? '?expand=messages' : '';
    return okText(await call('tickets', `/v1/tickets/${encodeURIComponent(ticket_id)}${qs}`, 'GET'));
  },

  lsp_tickets_create: async (args) => {
    const body = args as Record<string, unknown>;
    // source='api' marks AI/tool-created tickets apart from 'manual' (a human in the
    // Admin UI) and 'email' (inbound mail) in the queue + stats.
    return okText(await call('tickets', '/v1/tickets', 'POST', { source: 'api', ...body }));
  },

  lsp_tickets_reply: async (args) => {
    const { ticket_id, ...rest } = args as { ticket_id: string } & Record<string, unknown>;
    // author_type='ai' so the thread shows who actually wrote it. visibility defaults to
    // 'internal' server-side — a public reply is real mail and must be asked for explicitly.
    return okText(
      await call('tickets', `/v1/tickets/${encodeURIComponent(ticket_id)}/messages`, 'POST', {
        author_type: 'ai',
        ...rest,
      }),
    );
  },

  lsp_tickets_transition: async (args) => {
    const { ticket_id, to_state, reason } = args as {
      ticket_id: string;
      to_state: string;
      reason?: string;
    };
    return okText(
      await call('tickets', `/v1/tickets/${encodeURIComponent(ticket_id)}/transitions`, 'POST', {
        to_state,
        reason,
      }),
    );
  },

  lsp_tickets_triage: async (args) => {
    const { ticket_id } = args as { ticket_id: string };
    return okText(
      await call('tickets', `/v1/tickets/${encodeURIComponent(ticket_id)}/triage`, 'POST', {}),
    );
  },

  lsp_tickets_spawn_agent: async (args) => {
    const { ticket_id, ...rest } = args as { ticket_id: string } & Record<string, unknown>;
    return okText(
      await call('tickets', `/v1/tickets/${encodeURIComponent(ticket_id)}/spawn-agent`, 'POST', rest),
    );
  },
};
