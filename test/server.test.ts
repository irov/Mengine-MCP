import assert from "node:assert/strict";
import test from "node:test";

import {
  createMengineMcpServer,
  createUnconfiguredMengineMcpServer,
  CONFIGURED_SERVER_INSTRUCTIONS,
  makeShakeInputSteps,
  makeMengineMcpStatus,
} from "../src/server.js";
import type { SessionManager } from "../src/session.js";

const EXPECTED_TOOLS = [
  "app_build",
  "app_clean",
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
  "input_accelerometer",
  "input_keyboard",
  "input_mouse",
  "input_sequence",
  "input_shake",
  "input_touch",
  "ios_ui_alert",
  "ios_ui_press_button",
  "ios_ui_screenshot",
  "ios_ui_snapshot",
  "ios_ui_start",
  "ios_ui_status",
  "ios_ui_stop",
  "ios_ui_tap",
  "ios_ui_tap_element",
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
  "/workspace/game/.mengine/mcp.json",
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

test("high-risk tool schemas expose their required guards, defaults, and enums", () => {
  const server = createMengineMcpServer({} as SessionManager, configuredStatus);
  const launch = server.toolInputSchemaJson("app_launch") as { properties: Record<string, { default?: string; enum?: string[] }> };
  const evaluate = server.toolInputSchemaJson("script_eval") as { properties: Record<string, { enum?: string[] }> };
  const exceptionPolicy = server.toolInputSchemaJson("debug_set_exception_policy") as { properties: Record<string, { enum?: string[] }> };

  assert.deepEqual(launch.properties.mode?.enum, ["visible", "hidden_render", "headless_logic"]);
  assert.equal(launch.properties.mode?.default, "hidden_render");
  assert.deepEqual(evaluate.properties.scope?.enum, ["module", "globals", "frame"]);
  assert.deepEqual(exceptionPolicy.properties.policy?.enum, ["none", "uncaught", "all"]);
});

test("configured guidance is MCP-first, offscreen-aware, and self-contained", () => {
  assert.ok(CONFIGURED_SERVER_INSTRUCTIONS.length <= 512);
  assert.match(CONFIGURED_SERVER_INSTRUCTIONS, /prefer Mengine MCP/u);
  assert.match(CONFIGURED_SERVER_INSTRUCTIONS, /ios_ui_\*/u);
  assert.match(CONFIGURED_SERVER_INSTRUCTIONS, /frame_capture is offscreen/u);
  assert.match(CONFIGURED_SERVER_INSTRUCTIONS, /Use visible only if explicitly asked/u);

  const server = createMengineMcpServer({} as SessionManager, configuredStatus);
  const registered = server as unknown as {
    _registeredTools: Record<string, { description?: string }>;
  };
  assert.match(registered._registeredTools.frame_capture?.description ?? "", /does not need to be open, visible, or focused/u);
});

test("shake input alternates acceleration and finishes with a neutral settling window", () => {
  const steps = makeShakeInputSteps(4, 100, 50) as Array<{
    type: string;
    params?: { x: number; y: number; z: number };
    milliseconds?: number;
  }>;

  assert.deepEqual(steps[0], {
    type: "accelerometer",
    params: { x: 4, y: -1.4, z: 1 },
  });
  assert.deepEqual(steps[2], {
    type: "accelerometer",
    params: { x: -4, y: 1.4, z: 1 },
  });
  assert.deepEqual(steps.at(-2), {
    type: "accelerometer",
    params: { x: 0, y: 0, z: 1 },
  });
  assert.deepEqual(steps.at(-1), { type: "delay", milliseconds: 20 });
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
