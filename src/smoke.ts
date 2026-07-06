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

// -- ClaudeCode: Handoff end-to-end flow check (bug dfca61cf, 2026-07-06).
// Reachability alone missed a real break: the MCP intent enum didn't match the
// backend's ALL_INTENTS, so compose→create→send 400'd for 4 of 5 intents. This
// exercises the full governed chain and asserts a share_url comes back.
// Share-link-only (no recipient) → no Dispatch email fires. Creates one
// disposable drafting packet per run.
let handoffFlow: Result | null = null;
if (SERVICES.handoff.deployed) {
  try {
    // compose (skeleton) — proves the entry point responds
    await call('handoff', '/v1/packets/compose', 'POST', {
      repo_url: 'https://github.com/LifeSpaceLLC/LifeSpacePlatform',
      branch: 'main',
      intent: 'fresh_session',
    });
    // create — the intent MUST be a real backend ALL_INTENTS value or this 400s
    const created = (await call('handoff', '/v1/packets', 'POST', {
      repo_url: 'https://github.com/LifeSpaceLLC/LifeSpacePlatform',
      branch: 'main',
      title: 'MCP smoke: compose→create→send',
      summary_md: 'Disposable packet from the lsp-mcp smoke test. Safe to discard.',
      intent: 'fresh_session',
    })) as { packet?: { id?: string } };
    const packetId = created?.packet?.id;
    if (!packetId) throw new Error('create returned no packet.id');
    // send — MUST return a share_url
    const sent = (await call('handoff', `/v1/packets/${packetId}/send`, 'POST')) as {
      share?: { share_url?: string };
    };
    const shareUrl = sent?.share?.share_url;
    if (!shareUrl) throw new Error('send returned no share.share_url');
    handoffFlow = { service: 'handoff', ok: true, detail: `share_url ${shareUrl}` };
  } catch (err) {
    handoffFlow = {
      service: 'handoff',
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - s.length));
console.log('\nlsp-mcp smoke test');
console.log('===================');
for (const r of results) {
  const mark = r.ok ? 'OK ' : 'FAIL';
  console.log(`${mark}  ${pad(r.service, 10)}  ${r.detail}`);
}
if (handoffFlow) {
  const mark = handoffFlow.ok ? 'OK ' : 'FAIL';
  console.log(`${mark}  ${pad('handoff→flow', 12)}  ${handoffFlow.detail}`);
}
const flowChecks = handoffFlow ? [handoffFlow] : [];
const allChecks = [...results, ...flowChecks];
const passed = allChecks.filter((r) => r.ok).length;
console.log(`\n${passed}/${allChecks.length} checks passed.\n`);
process.exit(passed === allChecks.length ? 0 : 1);
