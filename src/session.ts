import { Buffer } from "node:buffer";
import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { realpath, readFile } from "node:fs/promises";
import net, { Server, Socket } from "node:net";
import path from "node:path";

import {
  AppDescriptor,
  LaunchProfile,
  LoadedDescriptor,
  RootMapping,
  findApp,
  findProfile,
  resolveDescriptorPath,
} from "./descriptor.js";
import { MengineRuntimeError, MengineRuntimeErrorCode } from "./errors.js";
import {
  MncpBinaryAssembler,
  MncpDecoder,
  MncpFrame,
  MncpFrameType,
  decodeJsonPayload,
  encodeBinaryFrames,
  encodeJsonFrame,
} from "./protocol.js";

type RuntimeResponse = {
  result?: unknown;
  error?: {
    code?: MengineRuntimeErrorCode;
    message?: string;
    data?: unknown;
  };
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  binary: MncpBinaryAssembler;
  response?: RuntimeResponse;
};

export type LaunchMode = "visible" | "hidden_render" | "headless_logic";

export type SessionStatus = {
  appId: string;
  profileId: string;
  requestedPlatform: string;
  effectivePlatform: string;
  mode: LaunchMode;
  state: "launching" | "connected" | "stopped" | "failed";
  pid?: number;
  capabilities: string[];
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
};

export function validateHandshakePayload(payload: unknown, token: string): string[] {
  if (payload === null || typeof payload !== "object") {
    throw new MengineRuntimeError("authentication_failed", "invalid MCP handshake payload");
  }

  const request = payload as { method?: unknown; params?: { token?: unknown; capabilities?: unknown } };
  if (request.method !== "handshake" || request.params?.token !== token) {
    throw new MengineRuntimeError("authentication_failed", "invalid MCP session token");
  }

  return Array.isArray(request.params.capabilities)
    ? request.params.capabilities.filter((value): value is string => typeof value === "string")
    : [];
}

type LaunchContext = {
  app: AppDescriptor;
  requestedProfile: LaunchProfile;
  effectiveProfile: LaunchProfile;
  mode: LaunchMode;
};

const MOBILE_PLATFORMS = new Set(["android", "ios", "ios-simulator"]);
const MAX_CAPTURED_LOG_LINES = 5000;

export class MengineSession {
  private server: Server | undefined;
  private socket: Socket | undefined;
  private process: ChildProcessWithoutNullStreams | undefined;
  private readonly decoder = new MncpDecoder();
  private readonly pending = new Map<number, PendingRequest>();
  private requestId = 1;
  private authenticated = false;
  private capabilities: string[] = [];
  private state: SessionStatus["state"] = "launching";
  private exitCode: number | null | undefined;
  private exitSignal: NodeJS.Signals | null | undefined;
  private readonly logs: string[] = [];
  private handshakeResolve: (() => void) | undefined;
  private handshakeReject: ((error: Error) => void) | undefined;

  public readonly token = randomBytes(32).toString("hex");

  public constructor(
    private readonly descriptor: LoadedDescriptor,
    private readonly context: LaunchContext,
  ) {}

  public async launch(): Promise<SessionStatus> {
    const listenHost = this.context.effectiveProfile.connectionHost;
    this.validateConnectionHost(listenHost);

    this.server = net.createServer(socket => this.onConnection(socket));
    this.server.on("error", error => this.fail(error));

    const port = await new Promise<number>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, listenHost, () => {
        this.server!.off("error", reject);
        const address = this.server!.address();
        if (address === null || typeof address === "string") {
          reject(new Error("unable to determine MNCP listener port"));
          return;
        }
        resolve(address.port);
      });
    });

    const variables = this.makeVariables(port);
    if (this.context.effectiveProfile.portForwardCommand !== undefined) {
      await runCommand(this.expandCommand(this.context.effectiveProfile.portForwardCommand, variables), this.resolveCwd(), process.env);
    }

    const profile = this.context.effectiveProfile;
    const args = profile.args.map(value => expandVariables(value, variables));
    if (profile.platform === "android") {
      args.push(
        "--es", "mengine.mcp.host", variables.mcpHost!,
        "--es", "mengine.mcp.port", variables.mcpPort!,
        "--es", "mengine.mcp.token", variables.mcpToken!,
        "--es", "mengine.mcp.mode", variables.mcpMode!,
      );
    } else if (!MOBILE_PLATFORMS.has(profile.platform)) {
      if (this.context.mode === "hidden_render") {
        args.push("--windowhidden", "--nopause", "--noalreadyrunning");
      } else if (this.context.mode === "headless_logic") {
        args.push("--norender", "--nopause", "--noalreadyrunning");
      }
    }
    const command = expandVariables(profile.command, variables);
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      ...Object.fromEntries(Object.entries(profile.environment).map(([key, value]) => [key, expandVariables(value, variables)])),
      MENGINE_MCP_HOST: variables.mcpHost,
      MENGINE_MCP_PORT: variables.mcpPort,
      MENGINE_MCP_TOKEN: variables.mcpToken,
      MENGINE_MCP_MODE: variables.mcpMode,
    };

    const child = spawn(command, args, {
      cwd: this.resolveCwd(),
      env: environment,
      stdio: "pipe",
    });

    child.stdin.end();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", value => this.captureLog("stdout", String(value)));
    child.stderr.on("data", value => this.captureLog("stderr", String(value)));
    child.once("error", error => this.fail(error));
    child.once("exit", (code, signal) => {
      this.exitCode = code;
      this.exitSignal = signal;
      this.state = this.authenticated ? "stopped" : "failed";
      if (!this.authenticated) {
        this.handshakeReject?.(new Error(`application exited before MCP handshake (code=${String(code)}, signal=${String(signal)})`));
      }
      this.rejectPending(new MengineRuntimeError("disconnected", "application process exited"));
    });
    this.process = child;

    await new Promise<void>((resolve, reject) => {
      this.handshakeResolve = resolve;
      this.handshakeReject = reject;
      const timeout = setTimeout(() => reject(new MengineRuntimeError("timeout", "timed out waiting for MCPPlugin handshake")), profile.connectTimeoutMs);
      const resolveWithCleanup = (): void => {
        clearTimeout(timeout);
        resolve();
      };
      const rejectWithCleanup = (error: Error): void => {
        clearTimeout(timeout);
        reject(error);
      };
      this.handshakeResolve = resolveWithCleanup;
      this.handshakeReject = rejectWithCleanup;
    });

    return this.status();
  }

  public status(): SessionStatus {
    return {
      appId: this.context.app.id,
      profileId: this.context.effectiveProfile.id,
      requestedPlatform: this.context.requestedProfile.platform,
      effectivePlatform: this.context.effectiveProfile.platform,
      mode: this.context.mode,
      state: this.state,
      ...(this.process?.pid === undefined ? {} : { pid: this.process.pid }),
      capabilities: [...this.capabilities],
      ...(this.exitCode === undefined ? {} : { exitCode: this.exitCode }),
      ...(this.exitSignal === undefined ? {} : { signal: this.exitSignal }),
    };
  }

  public readCapturedLogs(after = 0): { next: number; lines: string[] } {
    const safeAfter = Math.max(0, Math.min(after, this.logs.length));
    return { next: this.logs.length, lines: this.logs.slice(safeAfter) };
  }

  public async request(method: string, params: unknown, timeoutMs = 10_000, binary?: Buffer): Promise<unknown> {
    if (!this.authenticated || this.socket === undefined) {
      throw new MengineRuntimeError("disconnected", "application is not connected to MCP");
    }

    const requestId = this.allocateRequestId();
    const payload = binary === undefined
      ? { method, params }
      : { method, params, attachment: { size: binary.length } };

    const result = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        this.socket?.write(encodeJsonFrame(MncpFrameType.Cancel, requestId, { reason: "timeout" }));
        reject(new MengineRuntimeError("timeout", `runtime request '${method}' timed out`));
      }, timeoutMs);

      this.pending.set(requestId, {
        resolve,
        reject,
        timeout,
        binary: new MncpBinaryAssembler(),
      });
    });

    this.socket.write(encodeJsonFrame(MncpFrameType.Request, requestId, payload));
    if (binary !== undefined) {
      for (const frame of encodeBinaryFrames(requestId, binary)) {
        this.socket.write(frame);
      }
    }

    return result;
  }

  public async stop(force = false, gracefulTimeoutMs = 5_000): Promise<SessionStatus> {
    if (this.authenticated) {
      try {
        await this.request("app_stop", {}, Math.min(gracefulTimeoutMs, 2_000));
      } catch {
        // The process may exit before acknowledging the shutdown request.
      }
    }

    if (force && !this.authenticated && this.process !== undefined && this.process.exitCode === null) {
      this.process.kill("SIGKILL");
    }

    if (this.process !== undefined && this.process.exitCode === null) {
      await waitForExit(this.process, gracefulTimeoutMs);
    }

    if (force && this.process !== undefined && this.process.exitCode === null) {
      this.process.kill("SIGKILL");
      await waitForExit(this.process, 2_000);
    }

    this.close();
    return this.status();
  }

  public close(): void {
    this.socket?.destroy();
    this.socket = undefined;
    this.server?.close();
    this.server = undefined;
    this.authenticated = false;
    this.rejectPending(new MengineRuntimeError("disconnected", "MCP session closed"));
  }

  private validateConnectionHost(host: string): void {
    if (net.isIP(host) === 0 && host !== "localhost") {
      throw new Error(`connectionHost '${host}' must be an IP address or localhost`);
    }

    if (host === "127.0.0.1" || host === "::1" || host === "localhost") {
      return;
    }

    if (!this.context.effectiveProfile.allowedRemoteHosts.includes(host)) {
      throw new Error(`remote connectionHost '${host}' is not present in allowedRemoteHosts`);
    }
  }

  private onConnection(socket: Socket): void {
    if (this.socket !== undefined) {
      socket.destroy();
      return;
    }

    this.socket = socket;
    socket.setNoDelay(true);
    socket.on("data", data => {
      const buffer = typeof data === "string" ? Buffer.from(data) : data;
      this.onData(buffer);
    });
    socket.on("error", error => this.fail(error));
    socket.on("close", () => {
      this.socket = undefined;
      this.authenticated = false;
      this.rejectPending(new MengineRuntimeError("disconnected", "runtime socket disconnected"));
    });
  }

  private onData(data: Buffer): void {
    let frames: MncpFrame[];
    try {
      frames = this.decoder.push(data);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    for (const frame of frames) {
      this.onFrame(frame);
    }
  }

  private onFrame(frame: MncpFrame): void {
    if (!this.authenticated) {
      this.handleHandshake(frame);
      return;
    }

    if (frame.type === MncpFrameType.Response) {
      const pending = this.pending.get(frame.requestId);
      if (pending === undefined) {
        return;
      }

      pending.response = decodeJsonPayload(frame) as RuntimeResponse;
      this.finishPending(frame.requestId, pending);
      return;
    }

    if (frame.type === MncpFrameType.Binary) {
      const pending = this.pending.get(frame.requestId);
      if (pending === undefined) {
        return;
      }

      const binary = pending.binary.push(frame);
      if (binary !== undefined) {
        pending.resolve({ response: pending.response?.result ?? null, binary });
        clearTimeout(pending.timeout);
        this.pending.delete(frame.requestId);
      }
      return;
    }

    if (frame.type === MncpFrameType.Event) {
      const event = decodeJsonPayload(frame);
      this.captureLog("event", JSON.stringify(event));
    }
  }

  private handleHandshake(frame: MncpFrame): void {
    if (frame.type !== MncpFrameType.Request) {
      this.fail(new MengineRuntimeError("authentication_failed", "first MNCP frame must be a handshake request"));
      return;
    }

    const payload = decodeJsonPayload(frame);

    try {
      this.capabilities = validateHandshakePayload(payload, this.token);
    } catch (error) {
      this.socket?.write(encodeJsonFrame(MncpFrameType.Response, frame.requestId, {
        error: { code: "authentication_failed", message: "invalid MCP session token" },
      }));
      this.fail(error instanceof Error ? error : new MengineRuntimeError("authentication_failed", "invalid MCP session token"));
      return;
    }
    this.authenticated = true;
    this.state = "connected";
    this.socket?.write(encodeJsonFrame(MncpFrameType.Response, frame.requestId, {
      result: { protocol: 1, authenticated: true },
    }));
    this.handshakeResolve?.();
  }

  private finishPending(requestId: number, pending: PendingRequest): void {
    const response = pending.response;
    if (response === undefined) {
      return;
    }

    if (response.error !== undefined) {
      clearTimeout(pending.timeout);
      this.pending.delete(requestId);
      pending.reject(new MengineRuntimeError(
        response.error.code ?? "execution_error",
        response.error.message ?? "runtime request failed",
        response.error.data,
      ));
      return;
    }

    const resultRecord = response.result !== null && typeof response.result === "object"
      ? response.result as { attachment?: { size?: number } }
      : undefined;

    if (resultRecord?.attachment !== undefined) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pending.delete(requestId);
    pending.resolve(response.result);
  }

  private allocateRequestId(): number {
    for (;;) {
      const candidate = this.requestId++ >>> 0;
      if (candidate !== 0 && !this.pending.has(candidate)) {
        return candidate;
      }
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private fail(error: Error): void {
    this.state = "failed";
    this.captureLog("mcp", error.message);
    this.handshakeReject?.(error);
    this.rejectPending(error);
    this.socket?.destroy();
  }

  private captureLog(channel: string, value: string): void {
    for (const line of value.split(/\r?\n/u)) {
      if (line.length === 0) {
        continue;
      }
      this.logs.push(`[${channel}] ${line}`);
    }

    if (this.logs.length > MAX_CAPTURED_LOG_LINES) {
      this.logs.splice(0, this.logs.length - MAX_CAPTURED_LOG_LINES);
    }
  }

  private resolveCwd(): string {
    const cwd = this.context.effectiveProfile.cwd ?? this.descriptor.directory;
    return resolveDescriptorPath(this.descriptor, cwd);
  }

  private makeVariables(port: number): Record<string, string> {
    return {
      mcpHost: this.context.effectiveProfile.connectionHost,
      mcpPort: String(port),
      mcpToken: this.token,
      mcpMode: this.context.mode,
      appId: this.context.app.id,
      profileId: this.context.effectiveProfile.id,
    };
  }

  private expandCommand(command: string[], variables: Record<string, string>): string[] {
    return command.map(value => expandVariables(value, variables));
  }
}

export class SessionManager {
  private readonly sessions = new Map<string, MengineSession>();

  public constructor(private readonly descriptor: LoadedDescriptor) {}

  public list(): Array<{
    id: string;
    name: string;
    profiles: Array<{ id: string; platform: string }>;
    session?: SessionStatus;
  }> {
    return this.descriptor.value.apps.map(app => ({
      id: app.id,
      name: app.name,
      profiles: app.profiles.map(profile => ({ id: profile.id, platform: profile.platform })),
      ...(this.sessions.get(app.id) === undefined ? {} : { session: this.sessions.get(app.id)!.status() }),
    }));
  }

  public status(appId: string): SessionStatus {
    return this.requireSession(appId).status();
  }

  public async launch(appId: string, profileId: string, mode: LaunchMode): Promise<SessionStatus> {
    const existing = this.sessions.get(appId);
    if (existing !== undefined && !["stopped", "failed"].includes(existing.status().state)) {
      throw new Error(`application '${appId}' already has an active MCP session`);
    }
    existing?.close();

    const app = findApp(this.descriptor, appId);
    const requestedProfile = findProfile(app, profileId);
    let effectiveProfile = requestedProfile;

    if (mode === "headless_logic" && MOBILE_PLATFORMS.has(requestedProfile.platform)) {
      if (requestedProfile.logicHostProfile === undefined) {
        throw new MengineRuntimeError("unsupported", `profile '${profileId}' has no desktop logicHostProfile`);
      }
      effectiveProfile = findProfile(app, requestedProfile.logicHostProfile);
    }

    const session = new MengineSession(this.descriptor, { app, requestedProfile, effectiveProfile, mode });
    this.sessions.set(appId, session);

    try {
      return await session.launch();
    } catch (error) {
      await session.stop(true, 1_000).catch(() => session.close());
      throw error;
    }
  }

  public async install(appId: string, profileId: string): Promise<unknown> {
    const app = findApp(this.descriptor, appId);
    const profile = findProfile(app, profileId);
    if (profile.installCommand === undefined) {
      throw new MengineRuntimeError("unsupported", `profile '${profileId}' has no installCommand`);
    }

    const command = profile.installCommand.map(value => expandVariables(value, {
      appId,
      profileId,
      mcpHost: profile.connectionHost,
      mcpPort: "0",
      mcpToken: "",
      mcpMode: "visible",
    }));
    return runCommand(command, profile.cwd === undefined ? this.descriptor.directory : resolveDescriptorPath(this.descriptor, profile.cwd), process.env);
  }

  public async stop(appId: string, force: boolean, gracefulTimeoutMs: number): Promise<SessionStatus> {
    return this.requireSession(appId).stop(force, gracefulTimeoutMs);
  }

  public request(appId: string, method: string, params: unknown, timeoutMs?: number, binary?: Buffer): Promise<unknown> {
    return this.requireSession(appId).request(method, params, timeoutMs, binary);
  }

  public readCapturedLogs(appId: string, after: number): { next: number; lines: string[] } {
    return this.requireSession(appId).readCapturedLogs(after);
  }

  public async readScriptFile(appId: string, sourcePath: string): Promise<{ source: Buffer; modulePath: string; logicalPath: string }> {
    const app = findApp(this.descriptor, appId);
    const match = await readFromRoots(this.descriptor, app.scriptRoots, sourcePath);
    return { source: match.data, modulePath: match.relativePath, logicalPath: match.logicalPath };
  }

  public async readAssetFile(appId: string, sourcePath: string): Promise<{
    source: Buffer;
    logicalPath: string;
    fileGroup: string;
  }> {
    const app = findApp(this.descriptor, appId);
    const match = await readFromRoots(this.descriptor, app.assetRoots, sourcePath);
    return { source: match.data, logicalPath: match.logicalPath, fileGroup: match.root.fileGroup };
  }

  public async close(): Promise<void> {
    await Promise.all([...this.sessions.values()].map(session => session.stop(true, 1_000).catch(() => session.close())));
    this.sessions.clear();
  }

  private requireSession(appId: string): MengineSession {
    const session = this.sessions.get(appId);
    if (session === undefined) {
      throw new MengineRuntimeError("disconnected", `application '${appId}' has no MCP session`);
    }
    return session;
  }
}

async function readFromRoots(
  descriptor: LoadedDescriptor,
  roots: RootMapping[],
  sourcePath: string,
): Promise<{ data: Buffer; relativePath: string; logicalPath: string; root: RootMapping }> {
  const requested = await realpath(path.resolve(sourcePath));

  for (const root of roots) {
    const rootPath = await realpath(resolveDescriptorPath(descriptor, root.path));
    const relativePath = path.relative(rootPath, requested);
    if (relativePath === "" || (!relativePath.startsWith(`..${path.sep}`) && relativePath !== ".." && !path.isAbsolute(relativePath))) {
      const data = await readFile(requested);
      const logicalPath = path.posix.join(root.logicalPrefix, relativePath.split(path.sep).join(path.posix.sep));
      return { data, relativePath, logicalPath, root };
    }
  }

  throw new MengineRuntimeError("invalid_request", `path '${sourcePath}' is outside configured roots for '${descriptor.filePath}'`);
}

function expandVariables(value: string, variables: Record<string, string>): string {
  return value.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/gu, (match, key: string) => variables[key] ?? match);
}

async function runCommand(command: string[], cwd: string, environment: NodeJS.ProcessEnv): Promise<{
  command: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const executable = command[0];
  if (executable === undefined) {
    throw new Error("empty command");
  }

  const child = spawn(executable, command.slice(1), { cwd, env: environment, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", value => { stdout += String(value); });
  child.stderr.on("data", value => { stderr += String(value); });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === null) {
        reject(new Error(`command terminated by signal ${String(signal)}`));
        return;
      }
      resolve(code);
    });
  });

  if (exitCode !== 0) {
    throw new Error(`command failed with exit code ${exitCode}: ${stderr.trim()}`);
  }

  return { command, exitCode, stdout, stderr };
}

async function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }

  await Promise.race([
    new Promise<void>(resolve => child.once("exit", () => resolve())),
    new Promise<void>(resolve => setTimeout(resolve, timeoutMs)),
  ]);
}
