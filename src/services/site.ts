// -- ClaudeCode (2026-07-24): Site MCP tools. The Site service is the registry of
// web surfaces the platform can inspect, annotate and edit (LifeSpace_Site_Spec.md).
// Until now Site had a full REST API but ZERO MCP tools, so every site registration
// had to go through a session running scripts. These tools close that gap.
//
// Real routes (verified 2026-07-24 against Site/src/routes/sites.ts, projects.ts,
// comments.ts — all registered under prefix /v1):
//   GET    /v1/sites                              — flat list for the caller's tenant (no server-side paging)
//   GET    /v1/sites/:id                          — one site by uuid
//   GET    /v1/sites/by-slug/:slug                — one site by slug (the friendly path)
//   POST   /v1/sites                              — register {project_id, slug, environment, display_name, site_url, site_type, config?, keys_credential_label?}
//   PATCH  /v1/sites/:id                          — update; `config` is REPLACED wholesale server-side
//   GET    /v1/projects                           — Site projects (groups of sites) w/ site_count
//   GET    /v1/sites/by-slug/:slug/comments?path= — the notes/marks left on one page
//
// DELIBERATELY NOT EXPOSED: DELETE /v1/sites/:id and DELETE /v1/projects/:id.
// Deleting a site is destructive and stays a human-with-a-console action.
// Comment writes are not exposed either — comments are authored in the editor UI.
import type { ToolDef, ToolHandler } from '../types.js';
import { call, okText } from '../client.js';

const CONFIG_CS_EXAMPLE = `{"cs":{"brandkey":"coach_simple","domains":["coachsimple.com","coachsimple.net","coachsimple.ai"],"prod_domains":["coachsimple.com","coachsimple.net"],"sandbox_domains":["coachsimple.ai"],"prod_url":"https://coachsimple.com","sandbox_url":"https://coachsimple.ai","contract_base":"http://localhost:4500","render_prefix":"/proxy","env_rule":"com/net = prod, ai = sandbox"}}`;

export const tools: ToolDef[] = [
  {
    name: 'lsp_site_list',
    description:
      "List the web sites registered to the caller's tenant. Use this first when the user says 'what sites do we have', 'is <brand> registered', or before creating anything — a brand that already has a row must be updated, not re-created. Returns every field including `config`, so this is also how you read the current config before changing it. The service returns the whole list (newest first); limit/offset are applied client-side by this tool.",
    inputSchema: {
      type: 'object',
      properties: {
        environment: {
          type: 'string',
          enum: ['local', 'staging', 'prod'],
          description: 'Client-side filter to one environment. Omit for all.',
        },
        project_id: { type: 'string', description: 'Client-side filter to one Site project.' },
        limit: { type: 'number', description: 'Max rows to return (client-side).' },
        offset: { type: 'number', description: 'Rows to skip (client-side).' },
      },
    },
  },
  {
    name: 'lsp_site_get',
    description:
      "Fetch one site. Prefer `slug` — that is the name humans and URLs use (the editor lives at site.lifespace.com/<slug>). Pass `site_id` only when you already hold the uuid. Returns the full row including `config`, which carries the per-brand workshop settings (see lsp_site_create for the config.cs shape).",
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Site slug, e.g. "coach_simple". Preferred.' },
        site_id: { type: 'string', description: 'Site uuid. Use only if you have it.' },
      },
    },
  },
  {
    name: 'lsp_site_create',
    description:
      "Register a NEW site. A Site record is a web surface the platform can inspect, annotate (pin comments on a live page) and edit — it pairs a URL with its own isolated credentials in Keys.\n\n" +
      "COACH SIMPLE CONVENTION (Greg's ruling, 2026-07-24) — ONE SITE PER BRAND. slug = the brandkey, environment = 'prod'. Reason, in Greg's words: we are ALWAYS updating PRODUCTION — we mark up prod, do the work on sandbox to test, then push to PROD; we don't treat sandbox as another live site. Sandbox is a workshop stage carried INSIDE `config.cs` (prod_url / sandbox_url / prod_domains / sandbox_domains), NEVER a second site row. Do not create a '<brand>-sandbox' or '<brand>-staging' row for a Coach Simple brand.\n\n" +
      "WARNING — creating brand sites is Greg-gated. Do NOT create sites speculatively, in bulk, or 'to be safe'. Create only a site a human has explicitly named. If you are unsure whether the brand should exist, call lsp_site_list and ask.\n\n" +
      'Example config for a Coach Simple brand: ' + CONFIG_CS_EXAMPLE + '\n\n' +
      'project_id is required — call lsp_site_projects to find it. slug must be unique within the tenant (duplicate = 409).',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: {
          type: 'string',
          description: 'Site project uuid that groups this site. Get it from lsp_site_projects.',
        },
        slug: {
          type: 'string',
          description:
            'URL-safe identifier, unique within the tenant. For a Coach Simple brand this is the brandkey (e.g. "coach_simple").',
        },
        environment: {
          type: 'string',
          enum: ['local', 'staging', 'prod'],
          description:
            "Which environment this row IS. DB CHECK-constrained to these three. Coach Simple brands are always 'prod' — sandbox lives in config.cs, not in its own row.",
        },
        display_name: { type: 'string', description: 'Human label shown in the UI, e.g. "Coach Simple".' },
        site_url: {
          type: 'string',
          description: 'Base URL the platform renders/inspects, e.g. "https://coachsimple.com".',
        },
        site_type: {
          type: 'string',
          enum: ['wordpress', 'html', 'other', 'coach_simple'],
          description: "Which adapter drives this site. Coach Simple brands use 'coach_simple'.",
        },
        config: {
          type: 'object',
          description:
            'Free-form JSON settings for the adapter. Coach Simple brands carry the workshop stages under `cs` — example: ' +
            CONFIG_CS_EXAMPLE,
        },
        keys_credential_label: {
          type: 'string',
          description:
            "Optional. Label of an EXISTING Keys credential to link. Leave unset and the service assigns the canonical default `site:<site_id>` — that is what you want unless you are deliberately linking pre-existing credentials.",
        },
      },
      required: ['project_id', 'slug', 'environment', 'display_name', 'site_url', 'site_type'],
    },
  },
  {
    name: 'lsp_site_update',
    description:
      "Update an existing site. Identify it by `slug` (preferred) or `site_id`. Only the fields you pass change.\n\n" +
      'CONFIG IS MERGED, NOT REPLACED. The Site API replaces `config` wholesale, which would silently wipe every key you did not send — so this tool reads the site first and DEEP-MERGES your partial `config` into the current one before writing. Nested objects merge key-by-key; arrays are replaced whole (send the full array you want). Pass `config_replace: true` only when you deliberately want the old config discarded.\n\n' +
      "Remember the Coach Simple convention: a brand has ONE prod row — change a sandbox URL by updating `config.cs.sandbox_url`, never by adding a second site.",
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Slug of the site to update (preferred identifier).' },
        site_id: { type: 'string', description: 'Site uuid. Use only if you have it.' },
        new_slug: { type: 'string', description: 'Rename the slug. Must stay unique in the tenant.' },
        display_name: { type: 'string' },
        site_url: { type: 'string' },
        site_type: { type: 'string', enum: ['wordpress', 'html', 'other', 'coach_simple'] },
        environment: { type: 'string', enum: ['local', 'staging', 'prod'] },
        config: {
          type: 'object',
          description:
            'Partial config. Deep-merged into the current config by this tool, so sibling keys survive. Example: {"cs":{"sandbox_url":"https://coachsimple.ai"}} changes only that one key.',
        },
        config_replace: {
          type: 'boolean',
          description: 'Set true to overwrite config wholesale instead of merging. Destructive — default false.',
        },
        keys_credential_label: {
          type: 'string',
          description: 'Link a different Keys credential label. Rarely needed.',
        },
      },
    },
  },
  {
    name: 'lsp_site_projects',
    description:
      "List the Site projects for the caller's tenant. A project groups related sites (e.g. all the brands of one business) and its id is REQUIRED by lsp_site_create — call this first so you never guess a project_id. Each row carries slug, display_name and site_count.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'lsp_site_comments_list',
    description:
      "Read the comments (pinned notes / mark-ups) left on ONE page of a site. Use when the user says 'what did they mark up on the about page' or before working a site's feedback. Comments are stored as LSP Projects tasks behind the scenes; each returns body, author, pin position, status ('open' or 'done') and any replies. Read-only — comments are authored in the Site editor, not here.",
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Site slug.' },
        path: {
          type: 'string',
          description: 'Page path the comments sit on, e.g. "/about-us". Defaults to "/" (home).',
        },
      },
      required: ['slug'],
    },
  },
];

/** Deep-merge `patch` into `base`. Plain objects merge key-by-key; anything else
 *  (arrays, scalars, null) replaces. Used so a partial config update can never
 *  wipe sibling keys the caller didn't mention. */
function deepMerge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    const cur = out[k];
    const bothPlain =
      v !== null &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      cur !== null &&
      typeof cur === 'object' &&
      !Array.isArray(cur);
    out[k] = bothPlain
      ? deepMerge(cur as Record<string, unknown>, v as Record<string, unknown>)
      : v;
  }
  return out;
}

interface SiteRow {
  id: string;
  slug: string;
  environment: string;
  project_id: string;
  config?: Record<string, unknown> | null;
  [k: string]: unknown;
}

async function fetchSite(args: { slug?: string; site_id?: string }): Promise<SiteRow> {
  if (args.site_id) {
    return (await call('site', `/v1/sites/${encodeURIComponent(args.site_id)}`, 'GET')) as SiteRow;
  }
  if (args.slug) {
    return (await call('site', `/v1/sites/by-slug/${encodeURIComponent(args.slug)}`, 'GET')) as SiteRow;
  }
  throw new Error('Pass slug (preferred) or site_id.');
}

export const handlers: Record<string, ToolHandler> = {
  lsp_site_list: async (args) => {
    const { environment, project_id, limit, offset } = (args ?? {}) as {
      environment?: string;
      project_id?: string;
      limit?: number;
      offset?: number;
    };
    let rows = (await call('site', '/v1/sites', 'GET')) as SiteRow[];
    if (!Array.isArray(rows)) return okText(rows);
    if (environment) rows = rows.filter((r) => r.environment === environment);
    if (project_id) rows = rows.filter((r) => r.project_id === project_id);
    const start = offset ?? 0;
    const sliced = limit ? rows.slice(start, start + limit) : rows.slice(start);
    return okText({ count: sliced.length, total: rows.length, sites: sliced });
  },

  lsp_site_get: async (args) => okText(await fetchSite((args ?? {}) as { slug?: string; site_id?: string })),

  lsp_site_create: async (args) => {
    const body = (args ?? {}) as Record<string, unknown>;
    return okText(await call('site', '/v1/sites', 'POST', body));
  },

  lsp_site_update: async (args) => {
    const {
      slug,
      site_id,
      new_slug,
      config,
      config_replace,
      ...rest
    } = (args ?? {}) as {
      slug?: string;
      site_id?: string;
      new_slug?: string;
      config?: Record<string, unknown>;
      config_replace?: boolean;
    } & Record<string, unknown>;

    // Resolve the row first — we need its uuid for PATCH, and its current config
    // for the read-modify-write merge (the API replaces `config` wholesale).
    const current = await fetchSite({ slug, site_id });

    const body: Record<string, unknown> = { ...rest };
    if (new_slug) body.slug = new_slug;
    if (config !== undefined) {
      body.config = config_replace
        ? config
        : deepMerge((current.config ?? {}) as Record<string, unknown>, config);
    }

    return okText(await call('site', `/v1/sites/${encodeURIComponent(current.id)}`, 'PATCH', body));
  },

  lsp_site_projects: async () => okText(await call('site', '/v1/projects', 'GET')),

  lsp_site_comments_list: async (args) => {
    const { slug, path } = (args ?? {}) as { slug: string; path?: string };
    const qs = `?path=${encodeURIComponent(path ?? '/')}`;
    return okText(
      await call('site', `/v1/sites/by-slug/${encodeURIComponent(slug)}/comments${qs}`, 'GET'),
    );
  },
};
