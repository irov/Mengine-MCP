import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { loadDescriptor } from "../src/descriptor.js";

test("published descriptor example and JSON schema agree on protocol version", async () => {
  const descriptor = await loadDescriptor("mengine.mcp.example.json");
  const schemaSource = await readFile("schemas/mengine.mcp.schema.json", "utf8");
  const schema = JSON.parse(schemaSource) as {
    properties: { version: { const: number } };
    $defs: { launchProfile: { properties: { platform: { enum: string[] }; stopCommand: { $ref: string }; coreDeviceTunnel: { properties: { deviceId: { type: string } } } } } };
  };

  assert.equal(descriptor.value.version, 1);
  assert.equal(schema.properties.version.const, descriptor.value.version);
  assert.deepEqual(schema.$defs.launchProfile.properties.platform.enum, [
    "win32",
    "macos",
    "unix",
    "gdk",
    "android",
    "ios",
    "ios-simulator",
  ]);
  assert.equal(schema.$defs.launchProfile.properties.stopCommand.$ref, "#/$defs/command");
  assert.equal(schema.$defs.launchProfile.properties.coreDeviceTunnel.properties.deviceId.type, "string");
  assert.deepEqual(descriptor.value.apps[0]!.profiles[1]!.stopCommand, [
    "adb", "shell", "am", "force-stop", "org.example.game",
  ]);
});
