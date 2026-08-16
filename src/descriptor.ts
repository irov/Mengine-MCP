import { readFile } from "node:fs/promises";
import path from "node:path";
import * as z from "zod/v4";

import {
  DESCRIPTOR_DIRECTORY_NAME,
  DESCRIPTOR_FILE_NAME,
} from "./extensionSupport.js";

const CommandSchema = z.array(z.string()).min(1);
const CoreDeviceTunnelSchema = z.object({
  deviceId: z.string().min(1),
});
const IosUiAutomationSchema = z.object({
  provider: z.literal("xctest").default("xctest"),
  deviceId: z.string().min(1),
  targetBundleId: z.string().min(1),
  runnerCommand: CommandSchema,
  cwd: z.string().optional(),
  environment: z.record(z.string(), z.string()).default({}),
  startupTimeoutMs: z.number().int().positive().max(600_000).default(180_000),
  requestTimeoutMs: z.number().int().positive().max(300_000).default(30_000),
});
const LocalVariablesSchema = z.object({
  variables: z.record(z.string(), z.string()).default({}),
});

const RUNTIME_VARIABLES = new Set([
  "appId",
  "profileId",
  "mcpHost",
  "mcpPort",
  "mcpToken",
  "mcpMode",
  "iosUiHost",
  "iosUiPort",
  "iosUiToken",
  "iosUiTargetBundleId",
]);

const RootMappingSchema = z.object({
  path: z.string().min(1),
  logicalPrefix: z.string().default(""),
  fileGroup: z.string().default(""),
  modulePrefix: z.string().default(""),
});

const ProfileIdSchema = z.string().regex(
  /^[A-Za-z0-9][A-Za-z0-9._-]*$/u,
  "profile ids may contain only letters, numbers, '.', '_', and '-'",
);

const MengineBuildSchema = z.object({
  provider: z.literal("mengine"),
  configuration: z.literal("Debug").default("Debug"),
  deployPath: z.string().min(1),
  buildNumber: z.string().regex(/^\d+$/u).default("1"),
  buildVersion: z.string().regex(/^\d+\.\d+\.\d+$/u).default("1.0.0"),
  cmakeArguments: z.array(z.string()).default([]),
});

const LaunchProfileSchema = z.object({
  id: ProfileIdSchema,
  platform: z.enum(["win32", "macos", "unix", "gdk", "android", "ios", "ios-simulator"]),
  command: z.string().min(1).optional(),
  build: MengineBuildSchema.optional(),
  args: z.array(z.string()).default([]),
  cwd: z.string().optional(),
  environment: z.record(z.string(), z.string()).default({}),
  installCommand: CommandSchema.optional(),
  portForwardCommand: CommandSchema.optional(),
  stopCommand: CommandSchema.optional(),
  coreDeviceTunnel: CoreDeviceTunnelSchema.optional(),
  iosUiAutomation: IosUiAutomationSchema.optional(),
  logicHostProfile: z.string().optional(),
  connectionHost: z.string().default("127.0.0.1"),
  allowedRemoteHosts: z.array(z.string()).default([]),
  connectTimeoutMs: z.number().int().positive().default(15_000),
}).refine(profile => profile.command !== undefined || profile.build !== undefined, {
  message: "a launch profile requires either 'command' or 'build'",
});

const AppDescriptorSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  profiles: z.array(LaunchProfileSchema).min(1),
  scriptRoots: z.array(RootMappingSchema).default([]),
  assetRoots: z.array(RootMappingSchema).default([]),
});

const DescriptorSchema = z.object({
  version: z.literal(1),
  apps: z.array(AppDescriptorSchema).min(1),
});

export type RootMapping = z.infer<typeof RootMappingSchema>;
export type LaunchProfile = z.infer<typeof LaunchProfileSchema>;
export type AppDescriptor = z.infer<typeof AppDescriptorSchema>;
export type MengineMcpDescriptor = z.infer<typeof DescriptorSchema>;

export type LoadedDescriptor = {
  filePath: string;
  directory: string;
  rootDirectory: string;
  value: MengineMcpDescriptor;
};

export async function loadDescriptor(filePath: string): Promise<LoadedDescriptor> {
  const absolutePath = path.resolve(filePath);
  const source = await readFile(absolutePath, "utf8");
  let parsed: unknown;

  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(`invalid JSON in ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const localVariables = await loadLocalVariables(path.dirname(absolutePath));
  const expanded = expandLocalVariables(parsed, localVariables);
  assertNoMissingLocalVariables(expanded, absolutePath);
  const value = DescriptorSchema.parse(expanded);
  const ids = new Set<string>();
  const managedProfileIds = new Set<string>();

  for (const app of value.apps) {
    if (ids.has(app.id)) {
      throw new Error(`duplicate application id '${app.id}' in ${absolutePath}`);
    }
    ids.add(app.id);

    const profileIds = new Set<string>();
    for (const profile of app.profiles) {
      if (profileIds.has(profile.id)) {
        throw new Error(`duplicate profile '${profile.id}' for application '${app.id}'`);
      }
      profileIds.add(profile.id);

      if (profile.build !== undefined) {
        if (managedProfileIds.has(profile.id)) {
          throw new Error(`managed build profile id '${profile.id}' must be unique in ${absolutePath}`);
        }
        managedProfileIds.add(profile.id);
      }

      if (profile.iosUiAutomation !== undefined && !["ios", "ios-simulator"].includes(profile.platform)) {
        throw new Error(`profile '${profile.id}' configures iosUiAutomation for non-iOS platform '${profile.platform}'`);
      }
    }

    for (const profile of app.profiles) {
      if (profile.logicHostProfile !== undefined && !profileIds.has(profile.logicHostProfile)) {
        throw new Error(`profile '${profile.id}' references missing logicHostProfile '${profile.logicHostProfile}'`);
      }
    }
  }

  return {
    filePath: absolutePath,
    directory: path.dirname(absolutePath),
    rootDirectory: resolveDescriptorRoot(absolutePath),
    value,
  };
}

async function loadLocalVariables(directory: string): Promise<Record<string, string>> {
  const filePath = path.join(directory, "local.json");
  let source: string;

  try {
    source = await readFile(filePath, "utf8");
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(`invalid JSON in ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  return LocalVariablesSchema.parse(parsed).variables;
}

function expandLocalVariables(value: unknown, variables: Record<string, string>): unknown {
  if (typeof value === "string") {
    return value.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/gu, (match, key: string) => variables[key] ?? match);
  }

  if (Array.isArray(value)) {
    return value.map(item => expandLocalVariables(item, variables));
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expandLocalVariables(item, variables)]));
  }

  return value;
}

function assertNoMissingLocalVariables(value: unknown, descriptorPath: string): void {
  if (typeof value === "string") {
    for (const match of value.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/gu)) {
      const key = match[1]!;
      if (!RUNTIME_VARIABLES.has(key)) {
        throw new Error(`descriptor ${descriptorPath} references missing local variable '{${key}}'`);
      }
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      assertNoMissingLocalVariables(item, descriptorPath);
    }
    return;
  }

  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) {
      assertNoMissingLocalVariables(item, descriptorPath);
    }
  }
}

export function resolveDescriptorPath(descriptor: LoadedDescriptor, value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(descriptor.rootDirectory, value);
}

function resolveDescriptorRoot(filePath: string): string {
  const directory = path.dirname(filePath);

  if (path.basename(filePath) === DESCRIPTOR_FILE_NAME
    && path.basename(directory) === DESCRIPTOR_DIRECTORY_NAME) {
    return path.dirname(directory);
  }

  return directory;
}

export function findApp(descriptor: LoadedDescriptor, appId: string): AppDescriptor {
  const app = descriptor.value.apps.find(candidate => candidate.id === appId);
  if (app === undefined) {
    throw new Error(`unknown application '${appId}'`);
  }
  return app;
}

export function findProfile(app: AppDescriptor, profileId: string): LaunchProfile {
  const profile = app.profiles.find(candidate => candidate.id === profileId);
  if (profile === undefined) {
    throw new Error(`unknown profile '${profileId}' for application '${app.id}'`);
  }
  return profile;
}
