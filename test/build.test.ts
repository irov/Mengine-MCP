import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { BuildManager, resolveProfileBuildPaths } from "../src/build.js";
import { loadDescriptor } from "../src/descriptor.js";

async function makeManagedWorkspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "mengine-mcp-build-"));
  const descriptorDirectory = path.join(root, ".mengine");
  const engineRoot = path.join(root, "engine");
  const deployPath = path.join(root, "Deploy", "MacOS");
  await mkdir(descriptorDirectory);
  await mkdir(path.join(engineRoot, "cmake", "Xcode_MacOS"), { recursive: true });
  await mkdir(deployPath, { recursive: true });
  await writeFile(path.join(descriptorDirectory, "local.json"), JSON.stringify({ engineRoot }));
  await writeFile(path.join(descriptorDirectory, "mcp.json"), JSON.stringify({
    version: 1,
    apps: [{
      id: "game",
      name: "Game",
      profiles: [{
        id: "macos-debug",
        platform: "macos",
        build: {
          provider: "mengine",
          configuration: "Debug",
          deployPath: "./Deploy/MacOS",
        },
      }],
    }],
  }));

  const descriptor = await loadDescriptor(path.join(descriptorDirectory, "mcp.json"));
  return {
    root,
    descriptorDirectory,
    descriptor,
    profile: descriptor.value.apps[0]!.profiles[0]!,
  };
}

test("managed build paths are profile-scoped below .mengine/.cache/build", async () => {
  const workspace = await makeManagedWorkspace();
  const paths = resolveProfileBuildPaths(workspace.descriptor, "macos-debug");

  assert.equal(paths.root, path.join(workspace.descriptorDirectory, ".cache", "build", "macos-debug"));
  assert.equal(paths.solution, path.join(paths.root, "solution"));
  assert.equal(paths.output, path.join(paths.root, "output"));
  assert.equal(paths.runtime, path.join(paths.root, "runtime"));
  assert.throws(
    () => resolveProfileBuildPaths(workspace.descriptor, "../outside"),
    /not safe for a cache directory/u,
  );
});

test("managed macOS builds overwrite one profile cache and publish relative launch state", async () => {
  const workspace = await makeManagedWorkspace();
  const commands: string[][] = [];
  let launchPrepared = false;
  let launchCleaned = false;
  const manager = new BuildManager(workspace.descriptor, {
    runCommand: async command => {
      commands.push(command);
      if (command.includes("--build")) {
        const paths = resolveProfileBuildPaths(workspace.descriptor, workspace.profile.id);
        const executable = path.join(paths.output, "Game.app", "Contents", "MacOS", "Game");
        await mkdir(path.dirname(executable), { recursive: true });
        await writeFile(executable, "game");
        await chmod(executable, 0o755);
      }
      return { command, exitCode: 0, output: "" };
    },
    prepareMacLaunch: async (_profileId, _artifact, executable) => {
      launchPrepared = true;
      return {
        command: executable,
        cleanup: async () => { launchCleaned = true; },
      };
    },
  });

  const first = await manager.build(workspace.profile);
  const second = await manager.build(workspace.profile);
  const paths = manager.paths(workspace.profile.id);
  const gitignore = await readFile(path.join(workspace.descriptorDirectory, ".gitignore"), "utf8");

  assert.equal(first.status, "ready");
  assert.equal(second.status, "ready");
  assert.equal(second.artifact, "output/Game.app");
  assert.equal(second.executable, "output/Game.app/Contents/MacOS/Game");
  assert.equal(second.cwd, "runtime");
  assert.equal(commands.length, 4);
  assert.ok(commands[0]!.includes("-DMENGINE_BUILD_MENGINE_MASTER_RELEASE:BOOL=OFF"));
  assert.ok(commands[0]!.includes("-DMENGINE_BUILD_MENGINE_BUILD_PUBLISH:BOOL=OFF"));
  assert.ok(commands[0]!.includes("-DMENGINE_BUILD_MENGINE_DEVELOPMENT:BOOL=ON"));
  assert.ok(commands[0]!.includes("-DCMAKE_CXX_FLAGS:STRING=-std=c++17"));
  assert.equal(gitignore, ".cache/\nlocal.json\n");
  assert.equal((await manager.readState(workspace.profile.id))?.status, "ready");
  const launch = await manager.resolveManagedLaunch(workspace.profile);
  assert.equal(launch.command, path.join(
    paths.output,
    "Game.app",
    "Contents",
    "MacOS",
    "Game",
  ));
  assert.equal(launchPrepared, true);
  await launch.cleanup();
  assert.equal(launchCleaned, true);
});

test("a failed rebuild retains the last successful record without creating another profile directory", async () => {
  const workspace = await makeManagedWorkspace();
  let shouldFail = false;
  const manager = new BuildManager(workspace.descriptor, {
    runCommand: async command => {
      if (shouldFail) {
        throw new Error("compile failed");
      }
      if (command.includes("--build")) {
        const paths = resolveProfileBuildPaths(workspace.descriptor, workspace.profile.id);
        const executable = path.join(paths.output, "Game.app", "Contents", "MacOS", "Game");
        await mkdir(path.dirname(executable), { recursive: true });
        await writeFile(executable, "game");
        await chmod(executable, 0o755);
      }
      return { command, exitCode: 0, output: "" };
    },
  });

  const successful = await manager.build(workspace.profile);
  shouldFail = true;
  await assert.rejects(manager.build(workspace.profile), /compile failed/u);
  const paths = manager.paths(workspace.profile.id);
  const state = await manager.readState(workspace.profile.id);

  assert.equal(state?.status, "failed");
  assert.equal(state?.error, "compile failed");
  assert.deepEqual(state?.lastSuccessful, {
    startedAt: successful.startedAt,
    finishedAt: successful.finishedAt,
    artifact: "output/Game.app",
    executable: "output/Game.app/Contents/MacOS/Game",
    cwd: "runtime",
  });
  assert.equal((await stat(path.dirname(paths.root))).isDirectory(), true);
  await assert.rejects(manager.resolveManagedLaunch(workspace.profile), /latest build.*failed/u);

  assert.deepEqual(await manager.clean(workspace.profile.id), {
    profileId: workspace.profile.id,
    removed: true,
  });
  await assert.rejects(stat(paths.root), { code: "ENOENT" });
});
