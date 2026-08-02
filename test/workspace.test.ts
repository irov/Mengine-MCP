import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { findWorkspaceDescriptor, resolveDescriptor } from "../src/workspace.js";

test("descriptor resolution prioritizes CLI over environment and workspace", () => {
  const resolution = resolveDescriptor({
    argv: ["node", "server", "--config", "explicit.json"],
    cwd: "/workspace/game",
    environment: { MENGINE_MCP_CONFIG: "environment.json" },
    fileExists: () => true,
  });

  assert.equal(resolution.filePath, path.resolve("/workspace/game/explicit.json"));
  assert.equal(resolution.source, "argument");
  assert.equal(resolution.explicit, true);
});

test("descriptor resolution uses environment before workspace discovery", () => {
  const resolution = resolveDescriptor({
    argv: ["node", "server"],
    cwd: "/workspace/game",
    environment: { MENGINE_MCP_CONFIG: "environment.json" },
    fileExists: () => true,
  });

  assert.equal(resolution.filePath, path.resolve("/workspace/game/environment.json"));
  assert.equal(resolution.source, "environment");
  assert.equal(resolution.explicit, true);
});

test("workspace discovery walks from a nested Codex cwd to the descriptor", () => {
  const expected = path.resolve("/workspace/game/.mengine/mcp.json");
  const resolution = resolveDescriptor({
    argv: ["node", "server"],
    cwd: "/workspace/game/Game/Scripts",
    environment: {},
    fileExists: candidate => candidate === expected,
  });

  assert.equal(resolution.filePath, expected);
  assert.equal(resolution.source, "workspace");
  assert.equal(resolution.explicit, false);
});

test("workspace discovery does not accept the legacy root descriptor", () => {
  const legacy = path.resolve("/workspace/game/mengine.mcp.json");
  const resolution = resolveDescriptor({
    argv: ["node", "server"],
    cwd: "/workspace/game/Game/Scripts",
    environment: {},
    fileExists: candidate => candidate === legacy,
  });

  assert.equal(resolution.filePath, undefined);
  assert.equal(resolution.source, "missing");
});

test("workspace discovery is nonfatal when no descriptor exists", () => {
  const resolution = resolveDescriptor({
    argv: ["node", "server"],
    cwd: "/workspace/not-a-game",
    environment: {},
    fileExists: () => false,
  });

  assert.equal(resolution.filePath, undefined);
  assert.equal(resolution.source, "missing");
  assert.equal(resolution.explicit, false);
  assert.equal(findWorkspaceDescriptor("/workspace/not-a-game", () => false), undefined);
});

test("CLI config requires a following path", () => {
  assert.throws(() => resolveDescriptor({
    argv: ["node", "server", "--config"],
    cwd: "/workspace/game",
    environment: {},
  }), /--config requires a path/u);
});
