// -- ClaudeCode: Non-destructive smoke test — hits each deployed service with a safe read-only call.
// Run: npm run smoke
// Auth: set LSP_TOKEN for briefing mode, or LSP_REPO_PATH pointing at LifeSpacePlatform checkout for personal mode.
import { call } from './client.js';
import { SERVICES, type ServiceId } from './config.js';

type Result = { service: ServiceId; ok: boolean; detail: string };

const checks: Array<{ service: ServiceId; run: () => Promise<unknown> }> = [
  { service: 'dispatch', run: () => call('dispatch', '/v1/messages?limit=1', 'GET') },
  { service: 'keys', run: () => call('keys', '/v1/providers', 'GET') },
  { service: 'memory', run: () => call('memory', '/v1/memories/session-load', 'POST', {}) },
  { service: 'knowledge', run: () => call('knowledge', '/v1/docs?limit=1', 'GET') },
  { service: 'projects', run: () => call('projects', '/v1/projects?limit=1', 'GET') },
  { service: 'library', run: () => call('library', '/v1/entries?q=&limit=1', 'GET') },
  { service: 'tenant', run: () => call('tenant', '/v1/tenants', 'GET') },
  { service: 'trust', run: () => call('trust', '/v1/verify', 'GET') },
  { service: 'handoff', run: () => call('handoff', '/v1/packets?limit=1', 'GET') },
];

const results: Result[] = [];

for (const { service, run } of checks) {
  if (!SERVICES[service].deployed) {
    results.push({ service, ok: false, detail: 'not yet deployed' });
    continue;
  }
  try {
    const data = await run();
    const preview = JSON.stringify(data).slice(0, 120);
    results.push({ service, ok: true, detail: preview });
  } catch (err) {
    results.push({
      service,
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - s.length));
console.log('\nlsp-mcp smoke test');
console.log('===================');
for (const r of results) {
  const mark = r.ok ? 'OK ' : 'FAIL';
  console.log(`${mark}  ${pad(r.service, 10)}  ${r.detail}`);
}
const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} services reachable.\n`);
process.exit(passed === results.length ? 0 : 1);
