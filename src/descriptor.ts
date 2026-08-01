import { readFile } from "node:fs/promises";
import path from "node:path";
import * as z from "zod/v4";

const CommandSchema = z.array(z.string()).min(1);

const RootMappingSchema = z.object({
  path: z.string().min(1),
  logicalPrefix: z.string().default(""),
  fileGroup: z.string().default(""),
  modulePrefix: z.string().default(""),
});

const LaunchProfileSchema = z.object({
  id: z.string().min(1),
  platform: z.enum(["win32", "macos", "unix", "gdk", "android", "ios", "ios-simulator"]),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().optional(),
  environment: z.record(z.string(), z.string()).default({}),
  installCommand: CommandSchema.optional(),
  portForwardCommand: CommandSchema.optional(),
  logicHostProfile: z.string().optional(),
  connectionHost: z.string().default("127.0.0.1"),
  allowedRemoteHosts: z.array(z.string()).default([]),
  connectTimeoutMs: z.number().int().positive().default(15_000),
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

  const value = DescriptorSchema.parse(parsed);
  const ids = new Set<string>();

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
    value,
  };
}

export function resolveDescriptorPath(descriptor: LoadedDescriptor, value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(descriptor.directory, value);
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
