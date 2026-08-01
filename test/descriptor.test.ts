import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadDescriptor } from "../src/descriptor.js";

test("descriptor validates logic host references", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mengine-mcp-descriptor-"));
  const filePath = path.join(directory, "mengine.mcp.json");
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
  const filePath = path.join(directory, "mengine.mcp.json");
  await writeFile(filePath, JSON.stringify({
    version: 1,
    apps: [{ id: "game", name: "Game", profiles: [{ id: "mac", platform: "macos", command: "Game" }] }],
  }));

  const descriptor = await loadDescriptor(filePath);
  const profile = descriptor.value.apps[0]!.profiles[0]!;
  assert.equal(profile.connectionHost, "127.0.0.1");
  assert.deepEqual(profile.args, []);
  assert.deepEqual(descriptor.value.apps[0]!.scriptRoots, []);
});
