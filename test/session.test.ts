import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadDescriptor } from "../src/descriptor.js";
import { findCoreDeviceTunnelHost } from "../src/coreDevice.js";
import {
  SessionManager,
  makeLaunchArguments,
  makeLaunchEnvironment,
  resolveExecutableCommand,
  type LaunchMode,
} from "../src/session.js";

test("CoreDevice tunnel selection prefers a newly created private IPv6 utun address", () => {
  const host = findCoreDeviceTunnelHost({
    en0: [{ address: "192.168.1.2", netmask: "255.255.255.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: false, cidr: "192.168.1.2/24" }],
    utun3: [{ address: "fd00:old::2", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", mac: "00:00:00:00:00:00", internal: false, cidr: "fd00:old::2/64", scopeid: 0 }],
    utun4: [{ address: "fd00:new::2", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", mac: "00:00:00:00:00:00", internal: false, cidr: "fd00:new::2/64", scopeid: 0 }],
  }, new Set(["fd00:old::2"]));

  assert.equal(host, "fd00:new::2");
});

function variables(mode: LaunchMode) {
  return {
    appId: "sample",
    mcpHost: "127.0.0.1",
    mcpPort: "18790",
    mcpToken: "token",
    mcpMode: mode,
  };
}

test("desktop launches always pass managed MCP and CLI arguments", () => {
  for (const platform of ["win32", "macos", "unix"] as const) {
    const profile = { platform, args: ["--project={appId}"] };

    assert.deepEqual(makeLaunchArguments(profile, "visible", variables("visible")), [
      "--project=sample",
      "--mcp",
      "--mcp-host:127.0.0.1",
      "--mcp-port:18790",
      "--mcp-token:token",
      "--mcp-mode:visible",
      "--cli",
    ]);
    assert.deepEqual(makeLaunchArguments(profile, "hidden_render", variables("hidden_render")), [
      "--project=sample",
      "--mcp",
      "--mcp-host:127.0.0.1",
      "--mcp-port:18790",
      "--mcp-token:token",
      "--mcp-mode:hidden_render",
      "--cli",
      "--windowhidden",
      "--nopause",
      "--noalreadyrunning",
    ]);
    assert.deepEqual(makeLaunchArguments(profile, "headless_logic", variables("headless_logic")), [
      "--project=sample",
      "--mcp",
      "--mcp-host:127.0.0.1",
      "--mcp-port:18790",
      "--mcp-token:token",
      "--mcp-mode:headless_logic",
      "--cli",
      "--norender",
      "--nopause",
      "--noalreadyrunning",
    ]);
  }
});

test("iOS command-line launch passes MCP and CLI arguments without desktop window flags", () => {
  for (const platform of ["ios", "ios-simulator"] as const) {
    assert.deepEqual(makeLaunchArguments({
      platform,
      args: ["simctl", "launch", "booted", "org.example.game"],
    }, "hidden_render", variables("hidden_render")), [
      "simctl", "launch", "booted", "org.example.game",
      "--mcp",
      "--mcp-host:127.0.0.1",
      "--mcp-port:18790",
      "--mcp-token:token",
      "--mcp-mode:hidden_render",
      "--cli",
    ]);
  }
});

test("command-line profiles cannot override managed MCP arguments", () => {
  assert.throws(
    () => makeLaunchArguments({ platform: "macos", args: ["--mcp-token:committed-secret"] }, "hidden_render", variables("hidden_render")),
    /must not override managed MCP option/u,
  );
  assert.throws(
    () => makeLaunchArguments({ platform: "ios", args: ["--nomcp"] }, "visible", variables("visible")),
    /must not override managed MCP option/u,
  );
  assert.throws(
    () => makeLaunchArguments({ platform: "unix", args: ["--mcp-custom"] }, "visible", variables("visible")),
    /must not override managed MCP option/u,
  );
});

test("runtime endpoint values are never inherited through the child environment", () => {
  const environment = makeLaunchEnvironment({
    environment: { CUSTOM_VALUE: "{appId}", MENGINE_MCP_TOKEN: "profile-token" },
  }, variables("hidden_render"), {
    PATH: "/bin",
    MENGINE_MCP_HOST: "legacy-host",
    MENGINE_MCP_PORT: "1",
    MENGINE_MCP_TOKEN: "legacy-token",
    MENGINE_MCP_MODE: "visible",
    MENGINE_MCP_VERSION: "0.3.3",
  });

  assert.equal(environment.CUSTOM_VALUE, "sample");
  assert.equal(environment.MENGINE_MCP_HOST, undefined);
  assert.equal(environment.MENGINE_MCP_PORT, undefined);
  assert.equal(environment.MENGINE_MCP_TOKEN, undefined);
  assert.equal(environment.MENGINE_MCP_MODE, undefined);
  assert.equal(environment.MENGINE_MCP_VERSION, "0.3.3");
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

for (const platform of ["android", "ios", "ios-simulator"] as const) {
  test(`detached ${platform} launcher may exit before the runtime handshake`, { timeout: 10_000 }, async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "mengine-mcp-detached-"));
    const descriptorDirectory = path.join(directory, ".mengine");
    const filePath = path.join(descriptorDirectory, "mcp.json");
    await mkdir(descriptorDirectory);
    await writeFile(filePath, JSON.stringify({
      version: 1,
      apps: [{
        id: "game",
        name: "Game",
        profiles: [{
          id: platform,
          platform,
          command: process.execPath,
          args: [path.resolve("test/fixtures/detached-launcher.mjs")],
          connectTimeoutMs: 5_000,
        }],
      }],
    }));

    const manager = new SessionManager(await loadDescriptor(filePath));

    try {
      const launched = await manager.launch("game", platform, "hidden_render");
      assert.equal(launched.state, "connected");
      assert.equal(launched.launcherExitCode, 0);
      assert.equal(launched.pid, undefined);

      const stopped = await manager.stop("game", false, 2_000);
      assert.equal(stopped.state, "stopped");
    } finally {
      await manager.close();
    }
  });
}

test("nonzero detached launcher exit fails the launch", { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mengine-mcp-detached-error-"));
  const descriptorDirectory = path.join(directory, ".mengine");
  const filePath = path.join(descriptorDirectory, "mcp.json");
  await mkdir(descriptorDirectory);
  await writeFile(filePath, JSON.stringify({
    version: 1,
    apps: [{
      id: "game",
      name: "Game",
      profiles: [{
        id: "android",
        platform: "android",
        command: process.execPath,
        args: [path.resolve("test/fixtures/exit-nonzero-launcher.mjs")],
        connectTimeoutMs: 5_000,
      }],
    }],
  }));

  const manager = new SessionManager(await loadDescriptor(filePath));

  try {
    await assert.rejects(
      () => manager.launch("game", "android", "hidden_render"),
      /application launcher failed \(code=7, signal=null\)/u,
    );
  } finally {
    await manager.close();
  }
});

test("detached launch failure runs the configured stop command", { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mengine-mcp-detached-stop-"));
  const descriptorDirectory = path.join(directory, ".mengine");
  const filePath = path.join(descriptorDirectory, "mcp.json");
  const markerPath = path.join(directory, "stopped.txt");
  await mkdir(descriptorDirectory);
  await writeFile(filePath, JSON.stringify({
    version: 1,
    apps: [{
      id: "game",
      name: "Game",
      profiles: [{
        id: "ios-simulator",
        platform: "ios-simulator",
        command: process.execPath,
        args: [path.resolve("test/fixtures/exit-zero-launcher.mjs")],
        stopCommand: [
          process.execPath,
          "-e",
          "require('node:fs').writeFileSync(process.argv[1], 'stopped')",
          markerPath,
        ],
        connectTimeoutMs: 100,
      }],
    }],
  }));

  const manager = new SessionManager(await loadDescriptor(filePath));

  try {
    await assert.rejects(
      () => manager.launch("game", "ios-simulator", "hidden_render"),
      /timed out waiting for MCPPlugin handshake/u,
    );
    assert.equal(await readFile(markerPath, "utf8"), "stopped");
  } finally {
    await manager.close();
  }
});
