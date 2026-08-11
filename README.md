# @lifespace/mcp

Stdio MCP server wrapping live LifeSpace Platform services as first-class tools for Claude Code.

**Spec:** `../LifeSpace_MCP_Spec.md`
**User guide:** `../LifeSpace_MCP_UserGuide.md`

## Services + tools (9 services, 30 tools)

| Service | Tools | Status |
|---------|-------|--------|
| Dispatch | `lsp_dispatch_send`, `lsp_dispatch_list_messages`, `lsp_dispatch_get_message`, `lsp_dispatch_credits_balance` | Live |
| Keys | `lsp_keys_get`, `lsp_keys_list`, `lsp_keys_providers_list` | Live |
| Memory | `lsp_memory_add`, `lsp_memory_search`, `lsp_memory_update`, `lsp_memory_forget`, `lsp_memory_session_load` | Live |
| Knowledge | `lsp_knowledge_write`, `lsp_knowledge_read`, `lsp_knowledge_search`, `lsp_knowledge_list` | Live |
| Projects | `lsp_projects_task_create`, `lsp_projects_task_list`, `lsp_projects_task_update`, `lsp_projects_list` | Live |
| Library | `lsp_library_search`, `lsp_library_register`, `lsp_library_list_folders` | Live |
| Tenant | `lsp_tenant_list`, `lsp_tenant_briefing_create`, `lsp_tenant_briefing_list`, `lsp_tenant_briefing_revoke` | Live |
| Trust | `lsp_trust_whoami` | Live |
| Handoff | `lsp_handoff_compose`, `lsp_handoff_send`, `lsp_handoff_list`, `lsp_handoff_transition` | Scaffolded (returns 503 until deployed) |
| Skills | `lsp_skills_search`, `lsp_skills_get`, `lsp_skills_write`, `lsp_skills_publish`, `lsp_skills_list` | Live (2026-07-01) |

## Build

```bash
npm install
npm run build
```

## Smoke test

```bash
LSP_REPO_PATH="/path/to/LifeSpacePlatform" npm run smoke
```

### Personal-mode coverage (reading admin keys from `{Service}/.env`)

Today, only these services have their admin API keys committed locally:

- `Dispatch/.env` → `DISPATCH_ADMIN_API_KEY` ✓
- `Keys/.env` → `KEYS_ADMIN_API_KEY` ✓

Other services (Memory, Knowledge, Projects, Library, Tenant, Trust) store their admin keys on Railway only. Personal-mode smoke will report them as "No auth available" until you either:

1. **Redeem a briefing URL** (recommended) → set `LSP_TOKEN` in the MCP env block. One JWT works across all granted services. See `../LifeSpace_MCP_UserGuide.md` → Install.
2. **Set per-service admin keys** explicitly in the MCP env block (`MEMORY_ADMIN_API_KEY=…`, etc.). Requires fetching each from Railway.

Handoff always fails with "not yet deployed" until its Railway service goes live.

## Install (project-scoped)

MCP config is **project-scoped** via `.mcp.json` at the project root — NOT `~/.claude/settings.json`. This prevents cross-tenant stomping when multiple clients share the same machine.

### Local dev mode (for LifeSpacePlatform repo)

```bash
claude mcp add lsp --scope project -e LSP_REPO_PATH="/ABSOLUTE/PATH/TO/LifeSpacePlatform" -- node /ABSOLUTE/PATH/TO/LifeSpacePlatform/MCP/dist/server.js
```

### Briefing mode (for client projects)

```bash
claude mcp add lsp --scope project -e LSP_TOKEN='<jwt>' -- npx -y github:LifeSpaceLLC/LifeSpacePlatform_MCP
```

Both write to `.mcp.json` in the current project directory. Restart Claude Code. Tools appear as `mcp__lsp__*` for that project only.

### Why project scope?

Each client (Coach Simple, HarvestLoop, etc.) has its own tenant and its own JWT. If MCP were user-scoped (`~/.claude/settings.json`), every new session would overwrite the previous client's JWT. Project scope isolates each client's MCP config in its own `_git/` folder.

## Self-renewing folder token

The `LSP_TOKEN` in a project's `.mcp.json` is a 30-day agent JWT. The stdio server keeps it alive by itself — there is no mint-install-restart ceremony any more.

**What happens:** on boot, and once every 24h while running, the server decodes its own token's expiry. Inside **7 days of expiry** it calls Trust `POST /v1/agents/renew`, and on success it:

1. rewrites `env.LSP_TOKEN` in the `.mcp.json` that carries that exact token (atomic write; every other key and every other server entry is preserved untouched),
2. swaps the bearer in the **running process**, so the current session heals without a restart,
3. prints one line to stderr: `[lsp-token] LSP token renewed through <date>`.

**Grace policy.** Trust accepts a renewal while the token is valid and for **7 days after it expires** — so a 30-day token gets a 14-day window to self-heal, which covers a Mac that slept through a vacation or a scheduled routine that missed its slot. Past that, a human mints a replacement with `POST /v1/agents/tokens`. Renewal **preserves scope exactly** (tenant, role, modules) — it is a lifetime extension, never a re-grant; widening scope still requires a fresh mint. Trust refuses a renewal for a revoked session, a blocked user or tenant, a non-agent subject, or a token already renewed once (each token renews exactly one generation).

**When renewal fails,** the server keeps running on the old token, prints a loud stderr warning naming the expiry date, and emails one alert (`A folder token could not renew and dies <date>: <folder>`) — at most once per 72h per folder. The token value itself is never printed, logged, or emailed.

**Controls:**

| Env var | Effect |
|---------|--------|
| `LSP_TOKEN_AUTORENEW=0` | Disable self-renewal entirely. |
| `LSP_NO_REFRESH=1` | Per-run worker children: never renew, never write. Enforced — the Execute worker is the single refresher. |
| `LSP_MCP_CONFIG_PATH` | Point at the `.mcp.json` to rewrite. Default: walk up from cwd and match the entry whose `LSP_TOKEN` is byte-identical to the booted one. |
| `LSP_RENEWAL_ALERT_EMAIL` | Recipient for the failure alert. |

This is distinct from the in-memory refresh lifecycle in `src/auth.ts` (which renews the *access* token on a 401 using a revocable refresh token in `~/.lsp`). That one keeps a live session from dying mid-work; this one keeps the credential *on disk* current so a brand-new process still boots authenticated.

## Develop

```bash
LSP_REPO_PATH="/path/to/LifeSpacePlatform" npm run dev
```

Runs the server in dev mode via `tsx`. Used for local iteration.

## License

Open source. See LICENSE (pending).
