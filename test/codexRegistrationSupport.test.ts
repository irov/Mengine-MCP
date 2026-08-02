import assert from "node:assert/strict";
import test from "node:test";

import {
  CODEX_MCP_MANAGED_BY,
  CODEX_MCP_SERVER_NAME,
  classifyRegistration,
  isExecutableUnavailableError,
  isMissingMcpConfigurationError,
  makeManagedRegistrationArgs,
} from "../src/codexRegistrationSupport.js";

const executable = "/Applications/Visual Studio Code.app/Code Helper";
const serverPath = "/extensions/mengine-mcp/dist/mengine-mcp.mjs";
const version = "0.3.2";

function configuration(overrides: {
  command?: string;
  serverPath?: string;
  version?: string;
  managedBy?: string;
} = {}) {
  return {
    transport: {
      type: "stdio",
      command: overrides.command ?? executable,
      args: [overrides.serverPath ?? serverPath, "--managed-by", overrides.managedBy ?? CODEX_MCP_MANAGED_BY],
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        MENGINE_MCP_VERSION: overrides.version ?? version,
      },
    },
  };
}

test("registration classification distinguishes missing, current, stale, and unmanaged entries", () => {
  assert.equal(classifyRegistration(undefined, executable, serverPath, version), "missing");
  assert.equal(classifyRegistration(configuration(), executable, serverPath, version), "current");
  assert.equal(classifyRegistration(configuration({ version: "0.1.0" }), executable, serverPath, version), "stale");
  assert.equal(classifyRegistration(configuration({ serverPath: "/old/server.mjs" }), executable, serverPath, version), "stale");
  assert.equal(classifyRegistration(configuration({ managedBy: "someone-else" }), executable, serverPath, version), "unmanaged");
});

test("registration error helpers recognize missing entries and unavailable executables", () => {
  assert.equal(isMissingMcpConfigurationError({ code: 1, stderr: "MCP server not found" }), true);
  assert.equal(isMissingMcpConfigurationError({ code: 2, stderr: "MCP server not found" }), false);
  assert.equal(isExecutableUnavailableError({ code: "ENOENT" }), true);
  assert.equal(isExecutableUnavailableError({ code: "EACCES" }), true);
  assert.equal(isExecutableUnavailableError({ code: "EPERM" }), false);
});

test("managed registration is global, versioned, and does not pin a project config", () => {
  const args = makeManagedRegistrationArgs(executable, serverPath, version);

  assert.deepEqual(args, [
    "mcp",
    "add",
    CODEX_MCP_SERVER_NAME,
    "--env",
    "ELECTRON_RUN_AS_NODE=1",
    "--env",
    `MENGINE_MCP_VERSION=${version}`,
    "--",
    executable,
    serverPath,
    "--managed-by",
    CODEX_MCP_MANAGED_BY,
  ]);
  assert.equal(args.includes("--config"), false);
});
