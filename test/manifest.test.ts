import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  CONNECT_CODEX_COMMAND,
  CREATE_CONFIGURATION_COMMAND,
  DISCONNECT_CODEX_COMMAND,
  MCP_PROVIDER_ID,
  OPEN_CONFIGURATION_COMMAND,
  SHOW_CODEX_STATUS_COMMAND,
} from "../src/extensionSupport.js";

test("extension manifest matches the registered MCP provider and commands", async () => {
  const packageJson = JSON.parse(await readFile(path.resolve("package.json"), "utf8")) as {
    publisher: string;
    main: string;
    contributes: {
      mcpServerDefinitionProviders: Array<{ id: string }>;
      commands: Array<{ command: string }>;
    };
  };

  assert.equal(packageJson.publisher, "wonderland");
  assert.equal(packageJson.main, "./dist/extension.cjs");
  assert.deepEqual(
    packageJson.contributes.mcpServerDefinitionProviders.map(provider => provider.id),
    [MCP_PROVIDER_ID],
  );
  assert.deepEqual(
    packageJson.contributes.commands.map(command => command.command),
    [
      CREATE_CONFIGURATION_COMMAND,
      OPEN_CONFIGURATION_COMMAND,
      CONNECT_CODEX_COMMAND,
      DISCONNECT_CODEX_COMMAND,
      SHOW_CODEX_STATUS_COMMAND,
    ],
  );
});
