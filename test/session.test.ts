import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { makeLaunchArguments, resolveExecutableCommand } from "../src/session.js";

const variables = {
  appId: "sample",
  mcpHost: "127.0.0.1",
  mcpPort: "18790",
  mcpToken: "token",
  mcpMode: "visible",
};

test("desktop automation modes pass the existing CLI launch argument", () => {
  const profile = {
    platform: "macos" as const,
    args: ["--project={appId}"],
  };

  assert.deepEqual(makeLaunchArguments(profile, "visible", variables), [
    "--project=sample",
  ]);
  assert.deepEqual(makeLaunchArguments(profile, "hidden_render", variables), [
    "--project=sample",
    "--cli",
    "--windowhidden",
    "--nopause",
    "--noalreadyrunning",
  ]);
  assert.deepEqual(makeLaunchArguments(profile, "headless_logic", variables), [
    "--project=sample",
    "--cli",
    "--norender",
    "--nopause",
    "--noalreadyrunning",
  ]);
});

test("Android launch arguments remain Intent extras", () => {
  const args = makeLaunchArguments({
    platform: "android",
    args: ["shell", "am", "start"],
  }, "hidden_render", {
    appId: "sample",
    mcpHost: "127.0.0.1",
    mcpPort: "18790",
    mcpToken: "token",
    mcpMode: "hidden_render",
  });

  assert.deepEqual(args, [
    "shell", "am", "start",
    "--es", "mengine.mcp.host", "127.0.0.1",
    "--es", "mengine.mcp.port", "18790",
    "--es", "mengine.mcp.token", "token",
    "--es", "mengine.mcp.mode", "hidden_render",
  ]);
});

test("relative executable paths resolve from the game root independently of cwd", () => {
  const descriptor = {
    rootDirectory: "/workspace/game",
  } as Parameters<typeof resolveExecutableCommand>[0];

  assert.equal(
    resolveExecutableCommand(descriptor, "./build/Game"),
    path.resolve("/workspace/game/build/Game"),
  );
  assert.equal(resolveExecutableCommand(descriptor, "adb"), "adb");
});
