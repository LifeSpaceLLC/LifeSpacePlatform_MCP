// -- ClaudeCode: Thin HTTPS client for LSP services. Resolves auth per-service, formats errors.
import { SERVICES, authFor, type ServiceId } from './config.js';

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
  const url = `${cfg.url}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${authFor(service)}`,
    ...extraHeaders,
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
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
