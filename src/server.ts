#!/usr/bin/env node
// -- ClaudeCode: lsp-mcp — stdio MCP server aggregating all live LSP services.
// Entry point. Combines tool defs from each service module and dispatches CallTool requests.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import * as dispatch from './services/dispatch.js';
import * as keys from './services/keys.js';
import * as memory from './services/memory.js';
import * as knowledge from './services/knowledge.js';
import * as projects from './services/projects.js';
import * as library from './services/library.js';
import * as tenant from './services/tenant.js';
import * as trust from './services/trust.js';
import * as handoff from './services/handoff.js';
import * as promote from './services/promote.js';
import * as capture from './services/capture.js';
import * as canvas from './services/canvas.js';
import * as calendar from './services/calendar.js';
import * as assistant from './services/assistant.js';
import * as listen from './services/listen.js';
import * as skills from './services/skills.js';
import { errText } from './client.js';
import type { ToolDef, ToolHandler } from './types.js';

const modules = [dispatch, keys, memory, knowledge, projects, library, tenant, trust, handoff, promote, capture, canvas, calendar, assistant, listen, skills];

const allTools: ToolDef[] = modules.flatMap((m) => m.tools);
const allHandlers: Record<string, ToolHandler> = Object.assign(
  {},
  ...modules.map((m) => m.handlers),
);

const server = new Server(
  { name: 'lifespace-mcp', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: allTools }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const handler = allHandlers[name];
  if (!handler) {
    return errText(new Error(`Unknown tool: ${name}`));
  }
  try {
    return await handler(args ?? {});
  } catch (err) {
    return errText(err);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`lsp-mcp v0.1.0 running on stdio — ${allTools.length} tools across ${modules.length} services`);
