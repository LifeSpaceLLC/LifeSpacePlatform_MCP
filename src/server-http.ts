// -- ClaudeCode (2026-07-08): LifeSpace Connect — the REMOTE MCP entrypoint
// (order G1). Streamable HTTP transport + OAuth 2.1 facade over Trust. One
// codebase, two transports (D1): this file is the HTTP twin of src/server.ts
// (stdio). Same tool set, filtered per-caller by the JWT `modules` claim.
//
// Endpoints:
//   /.well-known/oauth-authorization-server  — AS metadata (via mcpAuthRouter)
//   /.well-known/oauth-protected-resource    — RS metadata
//   /authorize /token /register /revoke      — OAuth 2.1 + PKCE + DCR
//   /oauth/trust/callback                    — Trust SSO return leg
//   POST /mcp                                — Streamable HTTP MCP (bearer-auth)
//   /health                                  — liveness
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
// ClaudeCode 2026-08-19 01:44 PM PDT — the SDK's own /authorize handler, mounted a
// SECOND time under /authorize/r/:id. Reusing it (rather than hand-rolling the
// route) keeps client / redirect_uri / PKCE validation and the OAuth error shapes
// identical on both paths; the only difference is the path, which is where the
// registration id rides.
import { authorizationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { ConnectOAuthProvider } from './http/oauth-provider.js';
import {
  toolsForClaims,
  canCallTool,
  allHandlers,
  TOOL_MODULE,
  AGENT_PROMPT,
  AGENT_PROMPT_NAME,
  agentPromptMessages,
  type CallerClaims,
} from './http/tools.js';
import { requestContext } from './request-context.js';
import { errText } from './client.js';
import {
  renderStartPage,
  normalizeApp,
  renderRegistrationStartPage,
  renderRegistrationGonePage,
} from './http/start-page.js';
import { tenantName } from './http/tenants.js';
// ClaudeCode 2026-08-19 01:44 PM PDT — per-registration resource URLs + their
// management API. See http/registrations.ts for why the id lives in the URL.
import { isRegistrationId, issuerFor, resourceUrl, registrationSummary } from './http/registrations.js';
import { mountRegistrationsApi } from './http/registrations-api.js';

const CONNECT_BASE_URL = process.env.CONNECT_BASE_URL ?? 'https://connect.lifespace.com';
const issuerUrl = new URL(CONNECT_BASE_URL);
const resourceServerUrl = new URL('/mcp', CONNECT_BASE_URL);

const provider = new ConnectOAuthProvider();
const app = express();
app.set('trust proxy', true); // Railway terminates TLS in front of us

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'lifespace-connect', transport: 'streamable-http' });
});

// -- ClaudeCode (order G4): the hosted onboarding start page — where invite
// emails land. Public + tenant-safe (static instructions, zero secrets).
// ?app=cowork|claude-desktop|claude-code|codex preselects a tab.
app.get('/start', (req, res) => {
  res.type('html').send(renderStartPage(normalizeApp(req.query.app)));
});

// ClaudeCode 2026-08-25 — PER-REGISTRATION start page. Same page as the Claude
// Code tab of /start, except the command already carries the registration id and
// the header states, from the REGISTRATION ROW, who the connection is for and
// which tenant it reaches. Public + tenant-safe: it renders only what
// `registrationSummary` already serves publicly (labels, tenant name, the one
// intended address) — no seat roster, no secret. An id we can't vouch for gets a
// plain 404/410 page and never a working command.
app.get('/start/r/:regId', async (req, res) => {
  const id = String(req.params.regId ?? '');
  if (!isRegistrationId(id)) {
    res.status(404).type('html').send(renderRegistrationGonePage('unknown'));
    return;
  }
  try {
    const summary = await registrationSummary(id.toLowerCase());
    if (summary.status !== 'active') {
      const status = summary.status === 'unknown' ? 'unknown' : summary.status;
      res
        .status(status === 'unknown' ? 404 : 410)
        .type('html')
        .send(renderRegistrationGonePage(status));
      return;
    }
    res.type('html').send(renderRegistrationStartPage(summary));
  } catch {
    res.status(404).type('html').send(renderRegistrationGonePage('unknown'));
  }
});

// ClaudeCode 2026-08-19 01:48 PM PDT — PER-REGISTRATION RESOURCE URLS.
//
// This is the mechanism that makes the sign-in page verifiable. A folder's
// .mcp.json points at `/mcp/r/<registration_id>` instead of `/mcp`. The client
// discovers that resource's metadata, which names a per-registration
// authorization server, whose metadata names `/authorize/r/<registration_id>` —
// so the id arrives at /authorize because the CLIENT FOLLOWED OUR METADATA, not
// because anyone typed a query param. That is the whole difference between the
// amber "unverified" block and the green one.
//
// ORDER MATTERS: mcpAuthRouter mounts `/.well-known/oauth-authorization-server`
// and `/.well-known/oauth-protected-resource/mcp` with express `use()`, which
// PREFIX-matches — it would otherwise answer `/…/r/<id>` with the GLOBAL
// document and the registration would silently vanish. These routes must be
// registered first.
// Express 5 (path-to-regexp v8) dropped inline regex params, so the shape check
// is the `isRegistrationId` guard in every handler below — anything that is not a
// uuid gets a 404 rather than being treated as a registration.
const REG_PATH = '/:regId';

// RFC 9728 protected-resource metadata for one registration.
app.get(`/.well-known/oauth-protected-resource/mcp/r${REG_PATH}`, (req, res) => {
  const id = String(req.params.regId).toLowerCase();
  if (!isRegistrationId(id)) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.json({
    resource: resourceUrl(id),
    authorization_servers: [issuerFor(id)],
    scopes_supported: Array.from(new Set(Object.values(TOOL_MODULE))),
    resource_name: 'LifeSpace Connect',
  });
});

// RFC 8414 authorization-server metadata for the issuer `<base>/r/<id>`. Token,
// registration and revocation stay on the SHARED endpoints — only the authorize
// endpoint is per-registration, because that is the only leg a human ever sees.
app.get(`/.well-known/oauth-authorization-server/r${REG_PATH}`, (req, res) => {
  const id = String(req.params.regId).toLowerCase();
  if (!isRegistrationId(id)) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.json({
    issuer: issuerFor(id),
    authorization_endpoint: new URL(`/authorize/r/${id}`, CONNECT_BASE_URL).href,
    token_endpoint: new URL('/token', CONNECT_BASE_URL).href,
    registration_endpoint: new URL('/register', CONNECT_BASE_URL).href,
    revocation_endpoint: new URL('/revoke', CONNECT_BASE_URL).href,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
    revocation_endpoint_auth_methods_supported: ['client_secret_post'],
    scopes_supported: Array.from(new Set(Object.values(TOOL_MODULE))),
  });
});

// The per-registration authorize leg. The provider reads the id back off
// `req.originalUrl` (see oauth-provider.authorize) — no param merging needed,
// and nothing rendered on the page can alter it.
app.use(`/authorize/r${REG_PATH}`, authorizationHandler({ provider }));

// ClaudeCode 2026-08-19 01:52 PM PDT — registration management + the PUBLIC
// summary a session prints beside the sign-in link (never a bare URL again).
mountRegistrationsApi(app);

// -- ClaudeCode: OAuth 2.1 authorization-server + protected-resource metadata,
// /authorize, /token, /register (DCR), /revoke — all from the SDK, backed by
// our provider. MUST be mounted at the app root.
app.use(
  mcpAuthRouter({
    provider,
    issuerUrl,
    baseUrl: issuerUrl,
    resourceServerUrl,
    resourceName: 'LifeSpace Connect',
    scopesSupported: Array.from(new Set(Object.values(TOOL_MODULE))),
  }),
);

// -- ClaudeCode: the Trust SSO return leg. Reads the connect_txn cookie, closes
// the loop, and issues our authorization code (admins get the tenant picker).
app.get('/oauth/trust/callback', (req, res) => {
  provider.handleTrustCallback(req, res).catch(() => {
    if (!res.headersSent) res.status(500).send('Sign-in failed.');
  });
});

// ClaudeCode 2026-08-06 11:00 AM PDT — the interstitial's two buttons. /authorize
// now renders a landing page instead of redirecting into Google; Continue hands
// off to Trust SSO (OAuth params held server-side, keyed by the connect_txn
// cookie), Cancel lands on a terminal denied page with no redirect back.
app.get('/oauth/continue', (req, res) => {
  provider.handleContinue(req, res).catch(() => {
    if (!res.headersSent) res.status(500).send('Sign-in failed.');
  });
});
app.get('/oauth/cancel', (req, res) => {
  provider.handleCancel(req, res).catch(() => {
    if (!res.headersSent) res.status(500).send('Cancel failed.');
  });
});

// -- ClaudeCode (2026-07-09, G1 security fix): the admin tenant-picker submit.
// Validates the chosen tenant is in the caller's subtree, then issues the auth
// code scoped to it.
app.post('/oauth/consent', express.urlencoded({ extended: false }), (req, res) => {
  provider.handleConsent(req, res).catch(() => {
    if (!res.headersSent) res.status(500).send('Consent failed.');
  });
});

// -- ClaudeCode: the MCP endpoint. Stateless: a fresh Server + transport per
// request, tools filtered by the caller's claims, downstream calls authed as
// the caller via AsyncLocalStorage.
const bearerAuth = requireBearerAuth({
  verifier: provider,
  resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
});

// ClaudeCode 2026-08-19 01:56 PM PDT — lifted out of the inline /mcp handler so
// the per-registration endpoint below runs the SAME code, not a copy of it.
const handleMcpPost: express.RequestHandler = async (req, res) => {
  const authInfo = req.auth!;
  const claims = ((authInfo.extra?.claims as Record<string, unknown>) ?? {}) as CallerClaims;
  const bearer = authInfo.token;

  const server = await buildServer(claims);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless (D3)
    enableJsonResponse: true,
  });
  res.on('close', () => {
    transport.close();
    server.close();
  });

  try {
    await server.connect(transport);
    // Bind the caller's Trust JWT for every downstream LSP call this request makes.
    await requestContext.run({ bearer, claims: claims as Record<string, unknown> }, () =>
      transport.handleRequest(req, res, req.body),
    );
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: err instanceof Error ? err.message : 'Internal error' },
        id: null,
      });
    }
  }
};

app.post('/mcp', cors(), express.json(), bearerAuth, handleMcpPost);

// ClaudeCode 2026-08-19 01:56 PM PDT — the PER-REGISTRATION MCP endpoint. Same
// handler, same stateless transport, same claims-filtered tool set: the ONLY
// difference is the 401's resource-metadata pointer, which sends an
// unauthenticated client to THIS registration's discovery documents instead of
// the global ones — which is how the registration id reaches /authorize without
// anyone typing it. The access token itself is unchanged (a Trust JWT), so
// nothing downstream cares that the connection was registered.
app.post(`/mcp/r${REG_PATH}`, cors(), express.json(), (req, res, next) => {
  const id = String(req.params.regId).toLowerCase();
  if (!isRegistrationId(id)) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  requireBearerAuth({
    verifier: provider,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL(`/mcp/r/${id}`, CONNECT_BASE_URL)),
  })(req, res, next);
}, handleMcpPost);

// Stateless mode: no server-initiated SSE stream, no session teardown.
app.get('/mcp', (_req, res) => res.status(405).json({ error: 'Method Not Allowed' }));
app.delete('/mcp', (_req, res) => res.status(405).json({ error: 'Method Not Allowed' }));
app.get(`/mcp/r${REG_PATH}`, (_req, res) => res.status(405).json({ error: 'Method Not Allowed' }));
app.delete(`/mcp/r${REG_PATH}`, (_req, res) => res.status(405).json({ error: 'Method Not Allowed' }));

// ClaudeCode 2026-08-06 11:03 AM PDT — "what am I holding?" surfaced at connect
// time: the initialize response states the active tenant NAME (not just a uuid)
// and the signed-in identity, so a session never has to guess which tenant its
// connector is scoped to. Trust's /v1/verify (behind lsp_trust_whoami) already
// returns tenant_name; this makes the same fact visible without a tool call.
// Names are cached per tenant id — the mapping does not churn.
const tenantNameCache = new Map<string, string>();
async function activeTenantName(tenantId: string): Promise<string> {
  if (!tenantId) return '';
  const hit = tenantNameCache.get(tenantId);
  if (hit) return hit;
  try {
    const name = await tenantName(tenantId);
    tenantNameCache.set(tenantId, name);
    return name;
  } catch {
    return '';
  }
}

async function buildServer(claims: CallerClaims): Promise<Server> {
  const tenantId = typeof claims.tenant_id === 'string' ? claims.tenant_id : '';
  const email = typeof claims.email === 'string' ? claims.email : '';
  const name = claims.tenant_name || (await activeTenantName(tenantId));
  const instructions = [
    `LifeSpace Connect — active tenant: ${name || '(unknown)'}${tenantId ? ` (${tenantId})` : ''}.`,
    email ? `Signed in as ${email}.` : '',
    'Every tool call runs in this tenant only. Call lsp_trust_whoami to re-confirm.',
  ].filter(Boolean).join(' ');

  const server = new Server(
    { name: 'lifespace-connect', version: '0.1.0' },
    { capabilities: { tools: {}, prompts: {} }, instructions },
  );

  const visibleTools = toolsForClaims(claims);
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: visibleTools }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    // Belt-and-suspenders (D6): the filter hides ungranted tools; this stops a
    // direct call to one. The backing service's 403 is the real security.
    if (!canCallTool(name, claims)) {
      return errText(new Error(`Module not enabled for this user: ${TOOL_MODULE[name] ?? name}`));
    }
    const handler = allHandlers[name];
    if (!handler) return errText(new Error(`Unknown tool: ${name}`));
    try {
      return await handler(args ?? {});
    } catch (err) {
      return errText(err);
    }
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [AGENT_PROMPT] }));
  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    if (req.params.name !== AGENT_PROMPT_NAME) {
      throw new Error(`Unknown prompt: ${req.params.name}`);
    }
    const request = req.params.arguments?.request;
    return { messages: agentPromptMessages(typeof request === 'string' ? request : undefined) };
  });

  return server;
}

const port = parseInt(process.env.PORT ?? '8080', 10);
app.listen(port, '0.0.0.0', () => {
  console.log(`LifeSpace Connect (remote MCP) listening on :${port} — issuer ${CONNECT_BASE_URL}`);
});
