// -- ClaudeCode (2026-07-08): Per-request auth context for the HTTP transport
// (LifeSpace Connect). The stdio server has ONE identity for its whole life
// (env/config). The HTTP server serves many tenants concurrently — every /mcp
// request carries its own Trust JWT. We stash that JWT in AsyncLocalStorage so
// the existing `authFor()` in config.ts returns it for all downstream service
// calls, with zero changes to any tool handler. Empty in stdio mode (falls
// through to the env/config path), so stdio behaviour is untouched.
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  /** The verified Trust JWT for this request — forwarded to every LSP service. */
  bearer: string;
  /** Decoded JWT claims (role, modules, tenant_id, email…) for tool filtering. */
  claims?: Record<string, unknown>;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

/** The Trust JWT bound to the in-flight HTTP request, or undefined (stdio). */
export function currentRequestBearer(): string | undefined {
  return requestContext.getStore()?.bearer;
}
