import fs from "node:fs";
import path from "node:path";

import { DESCRIPTOR_RELATIVE_PATH } from "./extensionSupport.js";

export type DescriptorSource = "argument" | "environment" | "workspace" | "missing";

export type DescriptorResolution = {
  filePath?: string;
  source: DescriptorSource;
  explicit: boolean;
  searchedFrom: string;
};

export type ResolveDescriptorOptions = {
  argv?: readonly string[];
  cwd?: string;
  environment?: NodeJS.ProcessEnv;
  fileExists?: (filePath: string) => boolean;
};

export function resolveDescriptor(options: ResolveDescriptorOptions = {}): DescriptorResolution {
  const argv = options.argv ?? process.argv;
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const environment = options.environment ?? process.env;
  const fileExists = options.fileExists ?? isFile;
  const configArgumentIndex = argv.indexOf("--config");

  if (configArgumentIndex !== -1) {
    const value = argv[configArgumentIndex + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error("--config requires a path");
    }

    return {
      filePath: path.resolve(cwd, value),
      source: "argument",
      explicit: true,
      searchedFrom: cwd,
    };
  }

  const environmentPath = environment.MENGINE_MCP_CONFIG?.trim();
  if (environmentPath !== undefined && environmentPath.length > 0) {
    return {
      filePath: path.resolve(cwd, environmentPath),
      source: "environment",
      explicit: true,
      searchedFrom: cwd,
    };
  }

  const filePath = findWorkspaceDescriptor(cwd, fileExists);
  return {
    ...(filePath === undefined ? {} : { filePath }),
    source: filePath === undefined ? "missing" : "workspace",
    explicit: false,
    searchedFrom: cwd,
  };
}

export function findWorkspaceDescriptor(
  startDirectory: string,
  fileExists: (filePath: string) => boolean = isFile,
): string | undefined {
  let directory = path.resolve(startDirectory);

  for (;;) {
    const candidate = path.join(directory, DESCRIPTOR_RELATIVE_PATH);
    if (fileExists(candidate)) {
      return candidate;
    }

    const parent = path.dirname(directory);
    if (parent === directory) {
      return undefined;
    }

    directory = parent;
  }
}

function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}
