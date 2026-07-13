// -- ClaudeCode: Thin HTTPS client for LSP services. Resolves auth per-service, formats errors.
import { SERVICES, authFor, type ServiceId } from './config.js';
import { ensureReady, isTokenMode, refreshAccessToken } from './auth.js';

export async function call(
  service: ServiceId,
  path: string,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<unknown> {
  const cfg = SERVICES[service];
  if (!cfg.deployed) {
    throw new Error(
      `Service ${service} is scaffolded but not deployed yet. This tool will return useful results once the service goes live.`,
    );
  }
  // -- ClaudeCode (2026-07-06): Trust Auth v2 — ensure the token lifecycle is
  // initialized (zero-touch migration runs once, memoized). No-op in personal mode.
  await ensureReady();
  const url = `${cfg.url}${path}`;
  const doFetch = () => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${authFor(service)}`,
      ...extraHeaders,
    };
    // -- ClaudeCode (F3 2026-07-13): correlation-id spine. When a run-scoped
    // session is launched to service an inbound item (the Agent worker passes the
    // task's trace as LSP_CORRELATION_ID), thread it onto EVERY lsp_* write so the
    // resulting Dispatch send / Capture receipt / etc. joins the same pipeline
    // trace (listen.record.* → capture.item.* → agent.task.* → dispatch.message.*).
    // An explicit per-call X-Correlation-Id wins; interactive sessions (env unset)
    // are unaffected.
    const corr = process.env.LSP_CORRELATION_ID;
    const alreadySet = Object.keys(headers).some((h) => h.toLowerCase() === 'x-correlation-id');
    if (corr && !alreadySet) headers['X-Correlation-Id'] = corr;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  };
  let res = await doFetch();
  // -- ClaudeCode: silent refresh-on-401. If the access token lapsed, renew via
  // the stored refresh token and retry ONCE. A session that would have died mid-
  // work now self-heals with no user action. Only in token mode; only on 401.
  if (res.status === 401 && isTokenMode()) {
    const refreshed = await refreshAccessToken();
    if (refreshed) res = await doFetch();
  }
  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!res.ok) {
    const errMsg =
      (parsed && typeof parsed === 'object' && 'error' in parsed
        ? (parsed as { error: string }).error
        : typeof parsed === 'string'
          ? parsed
          : text) || `HTTP ${res.status}`;
    throw new Error(`${method} ${service}${path} → ${res.status}: ${errMsg}`);
  }
  return parsed;
}

export function okText(data: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  };
}

export function errText(err: unknown): {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
} {
  const msg = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: 'text', text: `Error: ${msg}` }],
    isError: true,
  };
}
