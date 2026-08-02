import os from "node:os";
import path from "node:path";

export type CodexCliCandidateOptions = {
  configuredPath?: string;
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  openAiExtensionPath?: string;
  platform?: NodeJS.Platform;
  architecture?: string;
};

export function getCodexCliCandidates(options: CodexCliCandidateOptions = {}): string[] {
  const environment = options.environment ?? process.env;
  const homeDirectory = options.homeDirectory ?? os.homedir();
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  const platformPath = platform === "win32" ? path.win32 : path.posix;
  const candidates: Array<string | undefined> = [
    options.configuredPath,
    environment.CODEX_CLI_PATH,
    getBundledCodexCliPath(options.openAiExtensionPath, platform, architecture, platformPath),
  ];

  if (platform === "darwin") {
    candidates.push(
      "/Applications/Codex.app/Contents/Resources/codex",
      platformPath.join(homeDirectory, "Applications", "Codex.app", "Contents", "Resources", "codex"),
      "/Applications/ChatGPT.app/Contents/Resources/codex",
      platformPath.join(homeDirectory, "Applications", "ChatGPT.app", "Contents", "Resources", "codex"),
    );
  } else if (platform === "win32") {
    for (const root of [environment.LOCALAPPDATA, environment.ProgramFiles, environment["ProgramFiles(x86)"]]
      .filter((value): value is string => Boolean(value))) {
      candidates.push(
        platformPath.join(root, "Programs", "Codex", "resources", "codex.exe"),
        platformPath.join(root, "Programs", "ChatGPT", "resources", "codex.exe"),
        platformPath.join(root, "Codex", "resources", "codex.exe"),
        platformPath.join(root, "ChatGPT", "resources", "codex.exe"),
      );
    }
  } else if (platform === "linux") {
    candidates.push(
      environment.APPDIR === undefined ? undefined : platformPath.join(environment.APPDIR, "usr", "bin", "codex"),
      platformPath.join(homeDirectory, ".local", "bin", "codex"),
      "/usr/local/bin/codex",
      "/usr/bin/codex",
    );
  }

  return [...new Set(candidates.filter((candidate): candidate is string => Boolean(candidate)))];
}

function getBundledCodexCliPath(
  extensionPath: string | undefined,
  platform: NodeJS.Platform,
  architecture: string,
  platformPath: path.PlatformPath,
): string | undefined {
  if (extensionPath === undefined) {
    return undefined;
  }

  const executableName = platform === "win32" ? "codex.exe" : "codex";
  let platformDirectory: string | undefined;

  if (platform === "darwin") {
    platformDirectory = architecture === "arm64" ? "macos-aarch64" : "macos-x64";
  } else if (platform === "linux") {
    platformDirectory = architecture === "arm64" ? "linux-arm64" : "linux-x64";
  } else if (platform === "win32") {
    platformDirectory = architecture === "arm64" ? "windows-arm64" : "windows-x64";
  }

  return platformDirectory === undefined
    ? undefined
    : platformPath.join(extensionPath, "bin", platformDirectory, executableName);
}
