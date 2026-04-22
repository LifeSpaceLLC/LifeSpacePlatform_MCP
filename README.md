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

## Install at user scope

Add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "lsp": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/LifeSpacePlatform/MCP/dist/server.js"],
      "env": {
        "LSP_REPO_PATH": "/ABSOLUTE/PATH/TO/LifeSpacePlatform"
      }
    }
  }
}
```

For briefing mode, replace `LSP_REPO_PATH` with `LSP_TOKEN`:

```json
"env": { "LSP_TOKEN": "eyJ..." }
```

Restart Claude Code. Tools appear as `mcp__lsp__*` in every session.

## Develop

```bash
LSP_REPO_PATH="/path/to/LifeSpacePlatform" npm run dev
```

Runs the server in dev mode via `tsx`. Used for local iteration.

## License

Open source. See LICENSE (pending).
