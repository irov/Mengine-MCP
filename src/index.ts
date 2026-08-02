#!/usr/bin/env node

import process from "node:process";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { loadDescriptor } from "./descriptor.js";
import {
  createMengineMcpServer,
  createUnconfiguredMengineMcpServer,
  makeMengineMcpStatus,
} from "./server.js";
import { SessionManager } from "./session.js";
import { resolveDescriptor } from "./workspace.js";

let manager: SessionManager | undefined;

try {
  const resolution = resolveDescriptor();
  let createServer;

  if (resolution.filePath === undefined) {
    const status = makeMengineMcpStatus(
      resolution.searchedFrom,
      undefined,
      resolution.source,
    );
    createServer = () => createUnconfiguredMengineMcpServer(status);
  } else {
    const descriptor = await loadDescriptor(resolution.filePath);
    manager = new SessionManager(descriptor);
    const status = makeMengineMcpStatus(
      resolution.searchedFrom,
      descriptor.filePath,
      resolution.source,
      descriptor.value.apps.map(app => ({
        id: app.id,
        profiles: app.profiles.map(profile => profile.id),
      })),
    );
    createServer = () => createMengineMcpServer(manager!, status);
  }

  const handle = serveStdio(createServer, {
    onerror: error => console.error(`mengine-mcp: ${error.message}`),
  });

  const shutdown = async (): Promise<void> => {
    await manager?.close();
    await handle.close();
  };

  process.once("SIGINT", () => { void shutdown(); });
  process.once("SIGTERM", () => { void shutdown(); });
} catch (error) {
  console.error(`mengine-mcp: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
