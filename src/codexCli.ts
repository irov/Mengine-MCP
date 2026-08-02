import fs from "node:fs";

import * as vscode from "vscode";

import { getCodexCliCandidates } from "./codexCliSupport.js";

export function resolveCodexCliExecutable(): string {
  const configuredPath = vscode.workspace.getConfiguration("chatgpt").get<string | null>("cliExecutable");
  const openAiExtensionPath = vscode.extensions.getExtension("openai.chatgpt")?.extensionPath;
  const candidates = getCodexCliCandidates({
    ...(configuredPath === undefined || configuredPath === null ? {} : { configuredPath }),
    ...(openAiExtensionPath === undefined ? {} : { openAiExtensionPath }),
  });
  const executable = candidates.find(candidate => fs.existsSync(candidate));
  return executable ?? "codex";
}
