import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  CREATE_CONFIGURATION_COMMAND,
  DESCRIPTOR_FILE_NAME,
  MCP_PROVIDER_ID,
  OPEN_CONFIGURATION_COMMAND,
  makeServerLabel,
  makeServerVersion,
} from "../src/extensionSupport.js";

test("VS Code provider uses stable descriptor and server identities", () => {
  assert.equal(DESCRIPTOR_FILE_NAME, "mengine.mcp.json");
  assert.equal(MCP_PROVIDER_ID, "mengine.mcp");
  assert.equal(CREATE_CONFIGURATION_COMMAND, "mengineMcp.createConfiguration");
  assert.equal(OPEN_CONFIGURATION_COMMAND, "mengineMcp.openConfiguration");
  assert.equal(makeServerLabel("My Game"), "Mengine MCP: My Game");
  assert.equal(makeServerVersion("0.1.0", 1234), "0.1.0:1234");
});

test("extension manifest contributes the registered MCP provider", async () => {
  const source = await readFile("package.json", "utf8");
  const packageJson = JSON.parse(source) as {
    publisher: string;
    name: string;
    contributes: {
      mcpServerDefinitionProviders: Array<{ id: string }>;
      jsonValidation: Array<{ fileMatch: string; url: string }>;
    };
  };

  assert.equal(`${packageJson.publisher}.${packageJson.name}`, "wonderland.mengine-mcp");
  assert.equal(packageJson.contributes.mcpServerDefinitionProviders[0]?.id, MCP_PROVIDER_ID);
  assert.deepEqual(packageJson.contributes.jsonValidation, [{
    fileMatch: "**/mengine.mcp.json",
    url: "./schemas/mengine.mcp.schema.json",
  }]);
});
