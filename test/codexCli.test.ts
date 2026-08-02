import assert from "node:assert/strict";
import test from "node:test";

import { getCodexCliCandidates } from "../src/codexCliSupport.js";

test("Codex CLI candidates prefer explicit configuration and the OpenAI extension bundle", () => {
  const candidates = getCodexCliCandidates({
    configuredPath: "/configured/codex",
    environment: { CODEX_CLI_PATH: "/environment/codex" },
    homeDirectory: "/Users/developer",
    openAiExtensionPath: "/extensions/openai.chatgpt",
    platform: "darwin",
    architecture: "arm64",
  });

  assert.deepEqual(candidates.slice(0, 3), [
    "/configured/codex",
    "/environment/codex",
    "/extensions/openai.chatgpt/bin/macos-aarch64/codex",
  ]);
  assert.ok(candidates.includes("/Applications/Codex.app/Contents/Resources/codex"));
});

test("Codex CLI candidates cover Windows and Linux installations", () => {
  const windows = getCodexCliCandidates({
    environment: { LOCALAPPDATA: "C:\\Users\\developer\\AppData\\Local" },
    homeDirectory: "C:\\Users\\developer",
    openAiExtensionPath: "C:\\extensions\\openai.chatgpt",
    platform: "win32",
    architecture: "x64",
  });
  assert.ok(windows.includes("C:\\extensions\\openai.chatgpt\\bin\\windows-x64\\codex.exe"));
  assert.ok(windows.includes("C:\\Users\\developer\\AppData\\Local\\Codex\\resources\\codex.exe"));

  const linux = getCodexCliCandidates({
    environment: {},
    homeDirectory: "/home/developer",
    openAiExtensionPath: "/extensions/openai.chatgpt",
    platform: "linux",
    architecture: "arm64",
  });
  assert.ok(linux.includes("/extensions/openai.chatgpt/bin/linux-arm64/codex"));
  assert.ok(linux.includes("/home/developer/.local/bin/codex"));
});
