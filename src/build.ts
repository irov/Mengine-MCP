import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  cp,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as z from "zod/v4";

import {
  LaunchProfile,
  LoadedDescriptor,
  resolveDescriptorPath,
} from "./descriptor.js";
import { MengineRuntimeError } from "./errors.js";
import {
  MENGINE_GITIGNORE_FILE_NAME,
  mergeMengineGitignore,
} from "./extensionSupport.js";

const CACHE_DIRECTORY_NAME = ".cache";
const CACHE_BUILD_DIRECTORY_NAME = "build";
const LOCAL_CONFIGURATION_FILE_NAME = "local.json";
const STATE_FILE_NAME = "state.json";
const LOG_FILE_NAME = "build.log";
const LOCK_FILE_NAME = ".build.lock";
const MAX_ERROR_OUTPUT = 64 * 1024;

const LocalConfigurationSchema = z.object({
  engineRoot: z.string().min(1),
  cmake: z.string().min(1).optional(),
});

export type BuildState = {
  profileId: string;
  platform: string;
  status: "building" | "ready" | "failed";
  startedAt: string;
  finishedAt?: string;
  artifact?: string;
  executable?: string;
  cwd?: string;
  error?: string;
  lastSuccessful?: SuccessfulBuildRecord;
};

export type SuccessfulBuildRecord = {
  startedAt: string;
  finishedAt: string;
  artifact: string;
  executable: string;
  cwd: string;
};

export type ProfileBuildPaths = {
  root: string;
  solution: string;
  output: string;
  runtime: string;
  log: string;
  state: string;
  lock: string;
};

type CommandResult = {
  command: string[];
  exitCode: number;
  output: string;
};

type BuildDependencies = {
  runCommand?: (command: string[], cwd: string, logPath: string) => Promise<CommandResult>;
  prepareMacLaunch?: (
    profileId: string,
    artifact: string,
    executable: string,
    paths: ProfileBuildPaths,
  ) => Promise<PreparedManagedLaunch>;
};

export type PreparedManagedLaunch = {
  command: string;
  cleanup: () => Promise<void>;
};

export type ManagedLaunch = PreparedManagedLaunch & {
  cwd: string;
};

export class BuildManager {
  private readonly runCommand: NonNullable<BuildDependencies["runCommand"]>;
  private readonly prepareMacLaunch: NonNullable<BuildDependencies["prepareMacLaunch"]>;

  public constructor(
    private readonly descriptor: LoadedDescriptor,
    dependencies: BuildDependencies = {},
  ) {
    this.runCommand = dependencies.runCommand ?? runLoggedCommand;
    this.prepareMacLaunch = dependencies.prepareMacLaunch
      ?? ((profileId, artifact, executable, paths) => this.prepareMacApplicationLaunch(
        profileId,
        artifact,
        executable,
        paths,
      ));
  }

  public paths(profileId: string): ProfileBuildPaths {
    return resolveProfileBuildPaths(this.descriptor, profileId);
  }

  public async readState(profileId: string): Promise<BuildState | undefined> {
    const paths = this.paths(profileId);

    try {
      const source = await readFile(paths.state, "utf8");
      return JSON.parse(source) as BuildState;
    } catch (error) {
      if (isMissingFileError(error)) {
        return undefined;
      }
      throw error;
    }
  }

  public async build(profile: LaunchProfile): Promise<BuildState> {
    if (profile.build === undefined) {
      throw new MengineRuntimeError("unsupported", `profile '${profile.id}' has no managed build`);
    }
    if (profile.platform !== "macos") {
      throw new MengineRuntimeError(
        "unsupported",
        `managed Mengine builds for '${profile.platform}' are not implemented yet`,
      );
    }

    const paths = this.paths(profile.id);
    await ensureCacheGitignore(this.descriptor.directory);
    await mkdir(paths.root, { recursive: true });
    const lock = await acquireBuildLock(paths.lock, profile.id);
    const startedAt = new Date().toISOString();
    const lastSuccessful = successfulBuildRecord(await this.readState(profile.id));

    try {
      await cleanupMacLaunchDirectory(this.descriptor, profile.id);
      await mkdir(paths.solution, { recursive: true });
      await mkdir(paths.output, { recursive: true });
      await mkdir(paths.runtime, { recursive: true });
      await writeFile(paths.log, "", "utf8");
      await writeState(paths.state, {
        profileId: profile.id,
        platform: profile.platform,
        status: "building",
        startedAt,
        ...(lastSuccessful === undefined ? {} : { lastSuccessful }),
      });

      const local = await loadLocalConfiguration(this.descriptor);
      const engineRoot = resolveDescriptorPath(this.descriptor, local.engineRoot);
      const deployPath = resolveDescriptorPath(this.descriptor, profile.build.deployPath);
      await requireDirectory(engineRoot, "Mengine root");
      await requireDirectory(deployPath, "deploy path");

      const cmake = await resolveCmakeExecutable(local.cmake);
      const sourceDirectory = path.join(engineRoot, "cmake", "Xcode_MacOS");
      await requireDirectory(sourceDirectory, "Mengine macOS CMake source");

      const configureCommand = [
        cmake,
        "-G", "Xcode",
        "-S", sourceDirectory,
        "-B", paths.solution,
        `-DCMAKE_BUILD_TYPE:STRING=${profile.build.configuration}`,
        `-DCMAKE_CONFIGURATION_TYPES:STRING=${profile.build.configuration}`,
        "-DMENGINE_DEPENDENCIES_PROJECT:STRING=Depends_Xcode_MacOS",
        `-DMENGINE_DEPLOY_PATH:PATH=${deployPath}`,
        `-DMENGINE_BUILD_NUMBER:STRING=${profile.build.buildNumber}`,
        `-DMENGINE_BUILD_VERSION:STRING=${profile.build.buildVersion}`,
        `-DMENGINE_APPLICATION_OUTPUT_PATH:PATH=${paths.output}`,
        "-DCMAKE_CXX_FLAGS:STRING=-std=c++17",
        "-DMENGINE_BUILD_MENGINE_MASTER_RELEASE:BOOL=OFF",
        "-DMENGINE_BUILD_MENGINE_BUILD_PUBLISH:BOOL=OFF",
        "-DMENGINE_BUILD_MENGINE_DEVELOPMENT:BOOL=ON",
        ...profile.build.cmakeArguments,
      ];
      await this.runCommand(configureCommand, this.descriptor.rootDirectory, paths.log);

      if (await isFile(path.join(paths.solution, "Podfile"))) {
        await this.runCommand(["pod", "install"], paths.solution, paths.log);
      }

      await this.runCommand([
        cmake,
        "--build", paths.solution,
        "--config", profile.build.configuration,
      ], this.descriptor.rootDirectory, paths.log);

      const artifact = await findSingleMacApplication(paths.output);
      const executable = await findSingleMacExecutable(artifact);
      const state: BuildState = {
        profileId: profile.id,
        platform: profile.platform,
        status: "ready",
        startedAt,
        finishedAt: new Date().toISOString(),
        artifact: relativeCachePath(paths.root, artifact),
        executable: relativeCachePath(paths.root, executable),
        cwd: relativeCachePath(paths.root, paths.runtime),
      };
      await writeState(paths.state, state);
      return state;
    } catch (error) {
      const state: BuildState = {
        profileId: profile.id,
        platform: profile.platform,
        status: "failed",
        startedAt,
        finishedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
        ...(lastSuccessful === undefined ? {} : { lastSuccessful }),
      };
      await writeState(paths.state, state).catch(() => undefined);
      throw error;
    } finally {
      await lock.close();
      await unlink(paths.lock).catch(() => undefined);
    }
  }

  public async clean(profileId: string): Promise<{ profileId: string; removed: boolean }> {
    const paths = this.paths(profileId);
    await cleanupMacLaunchDirectory(this.descriptor, profileId);
    const exists = await isDirectory(paths.root);
    if (!exists) {
      return { profileId, removed: false };
    }
    if (await isFile(paths.lock)) {
      throw new MengineRuntimeError("build_in_progress", `profile '${profileId}' is currently building`);
    }

    await rm(paths.root, { recursive: true, force: false });
    return { profileId, removed: true };
  }

  public async resolveManagedLaunch(profile: LaunchProfile): Promise<ManagedLaunch> {
    const paths = this.paths(profile.id);
    const state = await this.readState(profile.id);
    if (
      state?.status !== "ready"
      || state.artifact === undefined
      || state.executable === undefined
      || state.cwd === undefined
    ) {
      throw new MengineRuntimeError(
        "build_required",
        state?.status === "failed"
          ? `the latest build for profile '${profile.id}' failed; run app_build again`
          : `profile '${profile.id}' has no successful managed build; run app_build first`,
        state,
      );
    }

    const artifact = resolveCachedPath(paths.root, state.artifact);
    const command = resolveCachedPath(paths.root, state.executable);
    const cwd = resolveCachedPath(paths.root, state.cwd);
    await requireDirectory(artifact, "managed application bundle");
    if (!await isFile(command)) {
      throw new MengineRuntimeError("build_required", `built executable is missing for profile '${profile.id}'`);
    }
    await requireDirectory(cwd, "managed runtime directory");
    const prepared = await this.prepareMacLaunch(profile.id, artifact, command, paths);
    return { ...prepared, cwd };
  }

  private async prepareMacApplicationLaunch(
    profileId: string,
    artifact: string,
    executable: string,
    paths: ProfileBuildPaths,
  ): Promise<PreparedManagedLaunch> {
    const stagingDirectory = resolveMacLaunchDirectory(this.descriptor, profileId);
    await cleanupMacLaunchDirectory(this.descriptor, profileId);
    await mkdir(stagingDirectory, { recursive: true });

    try {
      const stagedArtifact = path.join(stagingDirectory, path.basename(artifact));
      await cp(artifact, stagedArtifact, { recursive: true, force: true, preserveTimestamps: true });
      await this.runCommand(["/usr/bin/xattr", "-cr", stagedArtifact], stagingDirectory, paths.log);
      await this.runCommand([
        "/usr/bin/codesign",
        "--force",
        "--deep",
        "--sign", "-",
        stagedArtifact,
      ], stagingDirectory, paths.log);
      await this.runCommand([
        "/usr/bin/codesign",
        "--verify",
        "--deep",
        "--strict",
        stagedArtifact,
      ], stagingDirectory, paths.log);

      const executableRelative = path.relative(artifact, executable);
      if (
        executableRelative === ""
        || executableRelative === ".."
        || executableRelative.startsWith(`..${path.sep}`)
        || path.isAbsolute(executableRelative)
      ) {
        throw new Error(`managed executable '${executable}' is outside application '${artifact}'`);
      }
      const stagedExecutable = path.join(stagedArtifact, executableRelative);
      if (!await isFile(stagedExecutable)) {
        throw new Error(`staged managed executable is missing: ${stagedExecutable}`);
      }

      return {
        command: stagedExecutable,
        cleanup: () => cleanupMacLaunchDirectory(this.descriptor, profileId),
      };
    } catch (error) {
      await cleanupMacLaunchDirectory(this.descriptor, profileId).catch(() => undefined);
      throw error;
    }
  }
}

function resolveMacLaunchDirectory(descriptor: LoadedDescriptor, profileId: string): string {
  assertSafeProfileId(profileId);
  const descriptorKey = createHash("sha256").update(descriptor.filePath).digest("hex").slice(0, 24);
  return path.join(os.tmpdir(), "mengine-mcp", "launch", descriptorKey, profileId);
}

async function cleanupMacLaunchDirectory(descriptor: LoadedDescriptor, profileId: string): Promise<void> {
  await rm(resolveMacLaunchDirectory(descriptor, profileId), { recursive: true, force: true });
}

function successfulBuildRecord(state: BuildState | undefined): SuccessfulBuildRecord | undefined {
  if (state?.status !== "ready") {
    return state?.lastSuccessful;
  }
  if (
    state.finishedAt === undefined
    || state.artifact === undefined
    || state.executable === undefined
    || state.cwd === undefined
  ) {
    return state.lastSuccessful;
  }

  return {
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    artifact: state.artifact,
    executable: state.executable,
    cwd: state.cwd,
  };
}

async function ensureCacheGitignore(descriptorDirectory: string): Promise<void> {
  const filePath = path.join(descriptorDirectory, MENGINE_GITIGNORE_FILE_NAME);
  let source = "";

  try {
    source = await readFile(filePath, "utf8");
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }

  const updated = mergeMengineGitignore(source);
  if (updated !== source) {
    await writeFile(filePath, updated, "utf8");
  }
}

export function resolveProfileBuildPaths(
  descriptor: Pick<LoadedDescriptor, "directory">,
  profileId: string,
): ProfileBuildPaths {
  assertSafeProfileId(profileId);
  const root = path.join(descriptor.directory, CACHE_DIRECTORY_NAME, CACHE_BUILD_DIRECTORY_NAME, profileId);
  return {
    root,
    solution: path.join(root, "solution"),
    output: path.join(root, "output"),
    runtime: path.join(root, "runtime"),
    log: path.join(root, LOG_FILE_NAME),
    state: path.join(root, STATE_FILE_NAME),
    lock: path.join(root, LOCK_FILE_NAME),
  };
}

async function loadLocalConfiguration(descriptor: LoadedDescriptor): Promise<z.infer<typeof LocalConfigurationSchema>> {
  const filePath = path.join(descriptor.directory, LOCAL_CONFIGURATION_FILE_NAME);
  let source: string;

  try {
    source = await readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      throw new MengineRuntimeError(
        "build_required",
        `managed builds require ${path.join(".mengine", LOCAL_CONFIGURATION_FILE_NAME)} with an engineRoot`,
      );
    }
    throw error;
  }

  try {
    return LocalConfigurationSchema.parse(JSON.parse(source));
  } catch (error) {
    throw new Error(`invalid local build configuration in ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function acquireBuildLock(lockPath: string, profileId: string) {
  try {
    const handle = await open(lockPath, "wx");
    await handle.writeFile(`${process.pid}\n`, "utf8");
    return handle;
  } catch (error) {
    if (isAlreadyExistsError(error)) {
      throw new MengineRuntimeError("build_in_progress", `profile '${profileId}' is already building`);
    }
    throw error;
  }
}

async function writeState(filePath: string, state: BuildState): Promise<void> {
  const temporaryPath = `${filePath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temporaryPath, filePath);
}

async function resolveCmakeExecutable(configured: string | undefined): Promise<string> {
  if (configured !== undefined) {
    return configured;
  }

  for (const candidate of [
    "/Applications/CMake.app/Contents/bin/cmake",
    "/opt/homebrew/bin/cmake",
    "/usr/local/bin/cmake",
  ]) {
    if (await isFile(candidate)) {
      return candidate;
    }
  }

  return "cmake";
}

async function findSingleMacApplication(outputDirectory: string): Promise<string> {
  const entries = await readdir(outputDirectory, { withFileTypes: true });
  const applications = entries
    .filter(entry => entry.isDirectory() && entry.name.endsWith(".app"))
    .map(entry => path.join(outputDirectory, entry.name));
  if (applications.length !== 1) {
    throw new Error(`expected one macOS application in ${outputDirectory}, found ${applications.length}`);
  }
  return applications[0]!;
}

async function findSingleMacExecutable(application: string): Promise<string> {
  const executableDirectory = path.join(application, "Contents", "MacOS");
  const entries = await readdir(executableDirectory, { withFileTypes: true });
  const executables: string[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const candidate = path.join(executableDirectory, entry.name);
    const info = await stat(candidate);
    if ((info.mode & 0o111) !== 0) {
      executables.push(candidate);
    }
  }

  if (executables.length !== 1) {
    throw new Error(`expected one executable in ${executableDirectory}, found ${executables.length}`);
  }
  return executables[0]!;
}

function relativeCachePath(root: string, value: string): string {
  const relative = path.relative(root, value);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`path '${value}' is outside managed build cache '${root}'`);
  }
  return relative.split(path.sep).join(path.posix.sep);
}

function resolveCachedPath(root: string, value: string): string {
  const resolved = path.resolve(root, value);
  const relative = path.relative(root, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`managed build path '${value}' escapes '${root}'`);
  }
  return resolved;
}

function assertSafeProfileId(profileId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(profileId)) {
    throw new Error(`profile id '${profileId}' is not safe for a cache directory`);
  }
}

async function requireDirectory(directory: string, label: string): Promise<void> {
  if (!await isDirectory(directory)) {
    throw new Error(`${label} does not exist: ${directory}`);
  }
}

async function isDirectory(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isDirectory();
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }
    throw error;
  }
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }
    throw error;
  }
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function isAlreadyExistsError(error: unknown): boolean {
  return Boolean(error !== null && typeof error === "object" && "code" in error && error.code === "EEXIST");
}

async function runLoggedCommand(command: string[], cwd: string, logPath: string): Promise<CommandResult> {
  const executable = command[0];
  if (executable === undefined) {
    throw new Error("empty build command");
  }

  const log = createWriteStream(logPath, { flags: "a", encoding: "utf8" });
  log.write(`\n$ ${command.map(renderArgument).join(" ")}\n`);
  const child = spawn(executable, command.slice(1), {
    cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";

  const capture = (value: unknown): void => {
    const text = String(value);
    output = `${output}${text}`.slice(-MAX_ERROR_OUTPUT);
    log.write(text);
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === null) {
        reject(new Error(`build command terminated by signal ${String(signal)}`));
        return;
      }
      resolve(code);
    });
  }).finally(() => new Promise<void>(resolve => log.end(resolve)));

  if (exitCode !== 0) {
    throw new Error(`build command failed with exit code ${exitCode}: ${output.trim()}`);
  }
  return { command, exitCode, output };
}

function renderArgument(value: string): string {
  return /^[A-Za-z0-9_./:=+-]+$/u.test(value) ? value : JSON.stringify(value);
}
