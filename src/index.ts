#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { loadDescriptor } from "./descriptor.js";
import { createMengineMcpServer } from "./server.js";
import { SessionManager } from "./session.js";

const configArgumentIndex = process.argv.indexOf("--config");
const configPath = configArgumentIndex === -1
  ? process.env.MENGINE_MCP_CONFIG ?? path.resolve("mengine.mcp.json")
  : process.argv[configArgumentIndex + 1];

if (configPath === undefined) {
  console.error("mengine-mcp: --config requires a path");
  process.exit(2);
}

try {
  const descriptor = await loadDescriptor(configPath);
  const manager = new SessionManager(descriptor);
  const handle = serveStdio(() => createMengineMcpServer(manager), {
    onerror: error => console.error(`mengine-mcp: ${error.message}`),
  });

  const shutdown = async (): Promise<void> => {
    await manager.close();
    await handle.close();
  };

  process.once("SIGINT", () => { void shutdown(); });
  process.once("SIGTERM", () => { void shutdown(); });
} catch (error) {
  console.error(`mengine-mcp: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
