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
import { renderStartPage, normalizeApp } from './http/start-page.js';

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

app.post('/mcp', cors(), express.json(), bearerAuth, async (req, res) => {
  const authInfo = req.auth!;
  const claims = ((authInfo.extra?.claims as Record<string, unknown>) ?? {}) as CallerClaims;
  const bearer = authInfo.token;

  const server = buildServer(claims);
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
});

// Stateless mode: no server-initiated SSE stream, no session teardown.
app.get('/mcp', (_req, res) => res.status(405).json({ error: 'Method Not Allowed' }));
app.delete('/mcp', (_req, res) => res.status(405).json({ error: 'Method Not Allowed' }));

function buildServer(claims: CallerClaims): Server {
  const server = new Server(
    { name: 'lifespace-connect', version: '0.1.0' },
    { capabilities: { tools: {}, prompts: {} } },
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
