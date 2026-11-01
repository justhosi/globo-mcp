#!/usr/bin/env node
/**
 * globo-mcp: unofficial MCP server (stdio) for the GLOBO Portal.
 *
 * Slice 1 registers a single read-only tool, `globo_whoami`.
 */

import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { PortalAuth } from "./auth.js";
import { loadConfig } from "./config.js";
import { HttpClient } from "./http.js";
import { getProfile } from "./portal/profile.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as unknown as { version: string };

async function main(): Promise<void> {
  const config = loadConfig();
  const auth = new PortalAuth(config, new HttpClient(config.baseUrl));
  const server = new McpServer({ name: "globo-mcp", version: pkg.version });

  server.registerTool(
    "globo_whoami",
    {
      description:
        "Show who is signed in to the GLOBO Portal: name, user id, email, time zone, payment method, and last sign-in.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const profile = await getProfile(auth);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(profile, null, 2) }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: message }],
          isError: true,
        };
      }
    },
  );

  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  // stderr only: stdout carries the JSON-RPC transport. Messages here are
  // ours (config/auth errors) and never contain credentials.
  console.error(`[globo-mcp] fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
