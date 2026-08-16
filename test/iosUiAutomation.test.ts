import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadDescriptor } from "../src/descriptor.js";
import { IosUiAutomationSession } from "../src/iosUiAutomation.js";

test("XCTest iOS UI bridge starts, inspects, taps, handles alerts, and stops", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mengine-ios-ui-"));
  const fixture = path.resolve("test/fixtures/xctest-ui-runner.mjs");
  const descriptorPath = path.join(root, "mcp.json");
  await writeFile(descriptorPath, JSON.stringify({
    version: 1,
    apps: [{
      id: "game",
      name: "Game",
      profiles: [{
        id: "ios",
        platform: "ios",
        command: "xcrun",
        iosUiAutomation: {
          deviceId: "device-1",
          targetBundleId: "com.example.game",
          runnerCommand: [process.execPath, fixture],
        },
      }],
    }],
  }));
  const descriptor = await loadDescriptor(descriptorPath);
  const profile = descriptor.value.apps[0]!.profiles[0]!;
  let tunnelCleaned = false;
  const session = new IosUiAutomationSession(descriptor, profile, profile.iosUiAutomation!, async deviceId => {
    assert.equal(deviceId, "device-1");
    return { host: "127.0.0.1", cleanup: async () => { tunnelCleaned = true; } };
  });

  assert.equal((await session.start()).state, "connected");
  assert.match(await session.snapshot(), /Consent/u);
  assert.deepEqual(await session.screenshot(), Buffer.from("png"));
  assert.deepEqual(await session.tap(0.5, 0.25, "normalized"), { x: 0.5, y: 0.25, coordinateSpace: "normalized" });
  assert.deepEqual(await session.tapElement("accessibility_id", "Consent", 0), { using: "accessibility_id", value: "Consent", index: 0 });
  assert.deepEqual(await session.pressButton("home"), { button: "home" });
  assert.deepEqual(await session.alert("buttons"), { buttons: ["Allow"] });
  assert.equal((await session.stop()).state, "stopped");
  assert.equal(tunnelCleaned, true);
});
