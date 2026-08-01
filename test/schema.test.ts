import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { loadDescriptor } from "../src/descriptor.js";

test("published descriptor example and JSON schema agree on protocol version", async () => {
  const descriptor = await loadDescriptor("mengine.mcp.example.json");
  const schemaSource = await readFile("schemas/mengine.mcp.schema.json", "utf8");
  const schema = JSON.parse(schemaSource) as {
    properties: { version: { const: number } };
    $defs: { launchProfile: { properties: { platform: { enum: string[] } } } };
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
});
