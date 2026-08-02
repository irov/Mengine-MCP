import assert from "node:assert/strict";
import test from "node:test";

import {
  createMengineMcpServer,
  createUnconfiguredMengineMcpServer,
  makeMengineMcpStatus,
} from "../src/server.js";
import type { SessionManager } from "../src/session.js";

const EXPECTED_TOOLS = [
  "app_install",
  "app_launch",
  "app_list",
  "app_status",
  "app_stop",
  "debug_continue",
  "debug_evaluate",
  "debug_pause",
  "debug_scopes",
  "debug_set_breakpoints",
  "debug_set_exception_policy",
  "debug_set_variable",
  "debug_stack",
  "debug_step",
  "debug_variables",
  "diagnostics_get",
  "frame_capture",
  "input_keyboard",
  "input_mouse",
  "input_sequence",
  "input_touch",
  "logs_read",
  "mengine_status",
  "resource_reload",
  "resource_revert",
  "runtime_control",
  "scene_find",
  "scene_get",
  "scene_set",
  "scene_snapshot",
  "script_call",
  "script_eval",
  "script_exec",
  "script_get",
  "script_inspect",
  "script_modules",
  "script_release",
  "script_reload_module",
  "script_set",
  "script_source",
  "wait_for",
] as const;

const configuredStatus = makeMengineMcpStatus(
  "/workspace/game",
  "/workspace/game/mengine.mcp.json",
  "workspace",
  [{ id: "game", profiles: ["macos-debug"] }],
);

test("MCP publishes the complete public tool set with object input schemas", () => {
  const server = createMengineMcpServer({} as SessionManager, configuredStatus);
  const registered = server as unknown as { _registeredTools: Record<string, unknown> };

  assert.deepEqual(Object.keys(registered._registeredTools).sort(), [...EXPECTED_TOOLS].sort());

  for (const name of EXPECTED_TOOLS) {
    const schema = server.toolInputSchemaJson(name) as { type?: unknown; properties?: unknown } | undefined;
    assert.ok(schema, `${name} has an input schema`);
    assert.equal(schema.type, "object", `${name} accepts an object`);
    assert.ok(schema.properties !== undefined, `${name} publishes JSON-schema properties`);
  }
});

test("high-risk tool schemas expose their required guards and enums", () => {
  const server = createMengineMcpServer({} as SessionManager, configuredStatus);
  const launch = server.toolInputSchemaJson("app_launch") as { properties: Record<string, { enum?: string[] }> };
  const evaluate = server.toolInputSchemaJson("script_eval") as { properties: Record<string, { enum?: string[] }> };
  const exceptionPolicy = server.toolInputSchemaJson("debug_set_exception_policy") as { properties: Record<string, { enum?: string[] }> };

  assert.deepEqual(launch.properties.mode?.enum, ["visible", "hidden_render", "headless_logic"]);
  assert.deepEqual(evaluate.properties.scope?.enum, ["module", "globals", "frame"]);
  assert.deepEqual(exceptionPolicy.properties.policy?.enum, ["none", "uncaught", "all"]);
});

test("unconfigured workspaces publish only the read-only status tool", () => {
  const server = createUnconfiguredMengineMcpServer(makeMengineMcpStatus(
    "/workspace/not-a-game",
    undefined,
    "missing",
  ));
  const registered = server as unknown as {
    _registeredTools: Record<string, { annotations?: { readOnlyHint?: boolean } }>;
  };

  assert.deepEqual(Object.keys(registered._registeredTools), ["mengine_status"]);
  assert.equal(registered._registeredTools.mengine_status?.annotations?.readOnlyHint, true);
});
