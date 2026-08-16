import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadDescriptor, resolveDescriptorPath } from "../src/descriptor.js";

test("descriptor validates logic host references", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mengine-mcp-descriptor-"));
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
        command: "adb",
        logicHostProfile: "missing",
      }],
    }],
  }));

  await assert.rejects(loadDescriptor(filePath), /missing logicHostProfile/u);
});

test("descriptor supplies stable defaults", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mengine-mcp-descriptor-"));
  const descriptorDirectory = path.join(directory, ".mengine");
  const filePath = path.join(descriptorDirectory, "mcp.json");
  await mkdir(descriptorDirectory);
  await writeFile(filePath, JSON.stringify({
    version: 1,
    apps: [{ id: "game", name: "Game", profiles: [{ id: "mac", platform: "macos", command: "Game" }] }],
  }));

  const descriptor = await loadDescriptor(filePath);
  const profile = descriptor.value.apps[0]!.profiles[0]!;
  assert.equal(profile.connectionHost, "127.0.0.1");
  assert.deepEqual(profile.args, []);
  assert.deepEqual(descriptor.value.apps[0]!.scriptRoots, []);
  assert.equal(descriptor.directory, descriptorDirectory);
  assert.equal(descriptor.rootDirectory, directory);
  assert.equal(resolveDescriptorPath(descriptor, "./Game"), path.join(directory, "Game"));
});

test("descriptor accepts managed build profiles without launch commands", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mengine-mcp-descriptor-"));
  const descriptorDirectory = path.join(directory, ".mengine");
  const filePath = path.join(descriptorDirectory, "mcp.json");
  await mkdir(descriptorDirectory);
  await writeFile(filePath, JSON.stringify({
    version: 1,
    apps: [{
      id: "game",
      name: "Game",
      profiles: [{
        id: "macos-debug",
        platform: "macos",
        build: { provider: "mengine", deployPath: "./Deploy/MacOS" },
      }],
    }],
  }));

  const descriptor = await loadDescriptor(filePath);
  const build = descriptor.value.apps[0]!.profiles[0]!.build;
  assert.equal(build?.configuration, "Debug");
  assert.equal(build?.buildNumber, "1");
  assert.equal(build?.buildVersion, "1.0.0");
  assert.deepEqual(build?.cmakeArguments, []);
});

test("descriptor rejects profiles without a command or managed build", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mengine-mcp-descriptor-"));
  const descriptorDirectory = path.join(directory, ".mengine");
  const filePath = path.join(descriptorDirectory, "mcp.json");
  await mkdir(descriptorDirectory);
  await writeFile(filePath, JSON.stringify({
    version: 1,
    apps: [{ id: "game", name: "Game", profiles: [{ id: "macos-debug", platform: "macos" }] }],
  }));

  await assert.rejects(loadDescriptor(filePath), /requires either 'command' or 'build'/u);
});

test("descriptor expands machine-local variables from .mengine/local.json", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mengine-mcp-local-"));
  const directory = path.join(root, ".mengine");
  const filePath = path.join(directory, "mcp.json");
  await mkdir(directory);
  await writeFile(path.join(directory, "local.json"), JSON.stringify({
    engineRoot: "/engine",
    variables: {
      iosDeviceId: "device-1",
      xcodeProject: "/tools/MengineMCPUIAutomation.xcodeproj",
    },
  }));
  await writeFile(filePath, JSON.stringify({
    version: 1,
    apps: [{
      id: "game",
      name: "Game",
      profiles: [{
        id: "ios-device",
        platform: "ios",
        command: "xcrun",
        args: ["--device", "{iosDeviceId}", "--mcp-port:{mcpPort}"],
        coreDeviceTunnel: { deviceId: "{iosDeviceId}" },
        iosUiAutomation: {
          deviceId: "{iosDeviceId}",
          targetBundleId: "com.example.game",
          runnerCommand: ["xcodebuild", "-project", "{xcodeProject}", "MENGINE_MCP_UI_HOST={iosUiHost}"],
        },
      }],
    }],
  }));

  const descriptor = await loadDescriptor(filePath);
  const profile = descriptor.value.apps[0]!.profiles[0]!;
  assert.deepEqual(profile.args, ["--device", "device-1", "--mcp-port:{mcpPort}"]);
  assert.deepEqual(profile.coreDeviceTunnel, { deviceId: "device-1" });
  assert.equal(profile.iosUiAutomation?.provider, "xctest");
  assert.equal(profile.iosUiAutomation?.deviceId, "device-1");
  assert.equal(profile.iosUiAutomation?.runnerCommand.at(-1), "MENGINE_MCP_UI_HOST={iosUiHost}");
});

test("descriptor rejects unresolved machine-local variables", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mengine-mcp-missing-local-"));
  const directory = path.join(root, ".mengine");
  const filePath = path.join(directory, "mcp.json");
  await mkdir(directory);
  await writeFile(filePath, JSON.stringify({
    version: 1,
    apps: [{
      id: "game",
      name: "Game",
      profiles: [{
        id: "ios-device",
        platform: "ios",
        command: "xcrun",
        args: ["--device", "{iosDeviceId}"],
      }],
    }],
  }));

  await assert.rejects(loadDescriptor(filePath), /missing local variable '\{iosDeviceId\}'/u);
});
