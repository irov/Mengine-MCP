import { Buffer } from "node:buffer";
import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import net, { Server, Socket } from "node:net";
import path from "node:path";

import { startCoreDeviceTunnel } from "./coreDevice.js";
import { LaunchProfile, LoadedDescriptor, resolveDescriptorPath } from "./descriptor.js";
import { MengineRuntimeError } from "./errors.js";

type IosUiAutomationConfig = NonNullable<LaunchProfile["iosUiAutomation"]>;

export type IosUiAutomationStatus = {
  state: "stopped" | "starting" | "connected" | "failed";
  deviceId: string;
  targetBundleId: string;
  ownsRunner: boolean;
  runnerPid?: number;
  error?: string;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

type JsonRecord = Record<string, unknown>;

const MAX_CAPTURED_LOG_LENGTH = 32_768;

export class IosUiAutomationSession {
  private server: Server | undefined;
  private socket: Socket | undefined;
  private process: ChildProcessWithoutNullStreams | undefined;
  private tunnelCleanup: (() => Promise<void>) | undefined;
  private state: IosUiAutomationStatus["state"] = "stopped";
  private ownsRunner = false;
  private error: string | undefined;
  private logs = "";
  private input = "";
  private requestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly token = randomBytes(32).toString("hex");
  private handshakeResolve: (() => void) | undefined;
  private handshakeReject: ((error: Error) => void) | undefined;
  private stopPromise: Promise<void> | undefined;

  public constructor(
    private readonly descriptor: LoadedDescriptor,
    private readonly profile: LaunchProfile,
    private readonly config: IosUiAutomationConfig,
    private readonly startTunnel: typeof startCoreDeviceTunnel = startCoreDeviceTunnel,
  ) {}

  public status(): IosUiAutomationStatus {
    return {
      state: this.state,
      deviceId: this.config.deviceId,
      targetBundleId: this.config.targetBundleId,
      ownsRunner: this.ownsRunner,
      ...(this.process?.pid === undefined ? {} : { runnerPid: this.process.pid }),
      ...(this.error === undefined ? {} : { error: this.error }),
    };
  }

  public async start(): Promise<IosUiAutomationStatus> {
    if (this.state === "connected") {
      return this.status();
    }
    if (this.state === "starting") {
      throw new MengineRuntimeError("build_in_progress", "iOS UI automation is already starting");
    }

    this.state = "starting";
    this.error = undefined;
    this.stopPromise = undefined;

    try {
      const tunnel = await this.startTunnel(this.config.deviceId);
      this.tunnelCleanup = tunnel.cleanup;
      const port = await this.startServer(tunnel.host);
      this.startRunner(tunnel.host, port);

      await new Promise<void>((resolve, reject) => {
        this.handshakeResolve = resolve;
        this.handshakeReject = reject;
        const timeout = setTimeout(() => reject(new MengineRuntimeError(
          "timeout",
          "timed out waiting for the XCTest UI runner",
          { logs: this.logs },
        )), this.config.startupTimeoutMs);
        const clear = (): void => clearTimeout(timeout);
        this.handshakeResolve = () => {
          clear();
          resolve();
        };
        this.handshakeReject = error => {
          clear();
          reject(error);
        };
      });

      this.state = "connected";
      return this.status();
    } catch (error) {
      this.state = "failed";
      this.error = error instanceof Error ? error.message : String(error);
      await this.cleanup();
      throw error;
    }
  }

  public async stop(): Promise<IosUiAutomationStatus> {
    if (this.stopPromise === undefined) {
      this.stopPromise = (async () => {
        if (this.state === "connected") {
          await this.request("stop", {}, 2_000).catch(() => undefined);
        }
        await this.cleanup();
        this.state = "stopped";
        this.error = undefined;
      })();
    }

    await this.stopPromise;
    return this.status();
  }

  public async snapshot(): Promise<string> {
    const value = asRecord(await this.request("snapshot"));
    if (typeof value.source !== "string") {
      throw new MengineRuntimeError("execution_error", "XCTest returned an invalid UI snapshot", value);
    }
    return value.source;
  }

  public async screenshot(): Promise<Buffer> {
    const value = asRecord(await this.request("screenshot"));
    if (typeof value.png !== "string") {
      throw new MengineRuntimeError("execution_error", "XCTest returned an invalid screenshot", value);
    }
    return Buffer.from(value.png, "base64");
  }

  public tap(x: number, y: number, coordinateSpace: "points" | "normalized"): Promise<unknown> {
    return this.request("tap", { x, y, coordinateSpace });
  }

  public tapElement(using: string, value: string, index: number): Promise<unknown> {
    return this.request("tapElement", { using, value, index });
  }

  public pressButton(button: "home" | "volume_up" | "volume_down"): Promise<unknown> {
    return this.request("pressButton", { button });
  }

  public alert(action: "text" | "buttons" | "accept" | "dismiss", buttonLabel?: string): Promise<unknown> {
    return this.request("alert", {
      action,
      ...(buttonLabel === undefined ? {} : { buttonLabel }),
    });
  }

  private async startServer(host: string): Promise<number> {
    this.server = net.createServer(socket => this.acceptSocket(socket));
    return new Promise<number>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, host, () => {
        this.server!.off("error", reject);
        const address = this.server!.address();
        if (address === null || typeof address === "string") {
          reject(new Error("unable to determine XCTest bridge port"));
          return;
        }
        resolve(address.port);
      });
    });
  }

  private startRunner(host: string, port: number): void {
    const variables = {
      iosUiHost: host,
      iosUiPort: String(port),
      iosUiToken: this.token,
      iosUiTargetBundleId: this.config.targetBundleId,
    };
    const [rawCommand, ...rawArguments] = this.config.runnerCommand;
    const command = resolveAutomationCommand(this.descriptor, expandVariables(rawCommand!, variables));
    const args = rawArguments.map(value => expandVariables(value, variables));
    const cwd = this.config.cwd === undefined
      ? this.descriptor.rootDirectory
      : resolveDescriptorPath(this.descriptor, this.config.cwd);
    const environment = {
      ...process.env,
      ...Object.fromEntries(Object.entries(this.config.environment).map(([key, value]) => [key, expandVariables(value, variables)])),
      MENGINE_MCP_UI_HOST: host,
      MENGINE_MCP_UI_PORT: String(port),
      MENGINE_MCP_UI_TOKEN: this.token,
      MENGINE_MCP_UI_TARGET_BUNDLE_ID: this.config.targetBundleId,
    };

    this.process = spawn(command, args, { cwd, env: environment, stdio: "pipe" });
    this.ownsRunner = true;
    this.process.stdin.end();
    this.process.stdout.setEncoding("utf8");
    this.process.stderr.setEncoding("utf8");
    this.process.stdout.on("data", value => this.captureLog(String(value)));
    this.process.stderr.on("data", value => this.captureLog(String(value)));
    this.process.once("error", error => this.fail(error));
    this.process.once("exit", (code, signal) => {
      if (this.state === "starting") {
        this.fail(new Error(`XCTest UI runner exited before handshake (code=${String(code)}, signal=${String(signal)})${this.logs.length === 0 ? "" : `: ${this.logs}`}`));
      } else if (this.state === "connected") {
        this.fail(new MengineRuntimeError("disconnected", `XCTest UI runner exited (code=${String(code)}, signal=${String(signal)})`));
      }
    });
  }

  private acceptSocket(socket: Socket): void {
    if (this.socket !== undefined) {
      socket.destroy();
      return;
    }
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", value => this.onData(String(value)));
    socket.on("error", error => this.fail(error));
    socket.on("close", () => {
      if (this.state === "connected") {
        this.fail(new MengineRuntimeError("disconnected", "XCTest UI runner disconnected"));
      }
    });
  }

  private onData(value: string): void {
    this.input += value;
    for (;;) {
      const newline = this.input.indexOf("\n");
      if (newline === -1) {
        break;
      }
      const line = this.input.slice(0, newline).trim();
      this.input = this.input.slice(newline + 1);
      if (line.length === 0) {
        continue;
      }

      try {
        this.onMessage(asRecord(JSON.parse(line)));
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private onMessage(message: JsonRecord): void {
    if (message.type === "hello") {
      if (message.token !== this.token) {
        this.socket?.destroy();
        throw new MengineRuntimeError("authentication_failed", "invalid XCTest UI runner token");
      }
      this.handshakeResolve?.();
      this.handshakeResolve = undefined;
      this.handshakeReject = undefined;
      return;
    }

    if (typeof message.id !== "number" || !Number.isInteger(message.id)) {
      throw new Error("invalid XCTest UI response id");
    }
    const pending = this.pending.get(message.id);
    if (pending === undefined) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pending.delete(message.id);
    if (message.ok === false) {
      pending.reject(new MengineRuntimeError(
        "execution_error",
        typeof message.error === "string" ? message.error : "XCTest UI command failed",
        message,
      ));
      return;
    }
    pending.resolve(message.result);
  }

  private request(command: string, params: JsonRecord = {}, timeoutMs = this.config.requestTimeoutMs): Promise<unknown> {
    const socket = this.socket;
    if (this.state !== "connected" || socket === undefined || socket.destroyed) {
      return Promise.reject(new MengineRuntimeError("disconnected", "iOS UI automation has no active XCTest session"));
    }

    const id = this.requestId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new MengineRuntimeError("timeout", `XCTest UI command '${command}' timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      socket.write(`${JSON.stringify({ id, command, params })}\n`, error => {
        if (error === null || error === undefined) {
          return;
        }
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  private fail(error: Error): void {
    this.state = "failed";
    this.error = error.message;
    this.handshakeReject?.(error);
    this.handshakeResolve = undefined;
    this.handshakeReject = undefined;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private captureLog(value: string): void {
    this.logs += value;
    if (this.logs.length > MAX_CAPTURED_LOG_LENGTH) {
      this.logs = this.logs.slice(-MAX_CAPTURED_LOG_LENGTH);
    }
  }

  private async cleanup(): Promise<void> {
    this.socket?.destroy();
    this.socket = undefined;
    if (this.server !== undefined) {
      await new Promise<void>(resolve => this.server!.close(() => resolve())).catch(() => undefined);
      this.server = undefined;
    }

    const process = this.process;
    this.process = undefined;
    if (process !== undefined && this.ownsRunner) {
      if (process.exitCode === null && process.signalCode === null) {
        process.kill("SIGTERM");
        await waitForExit(process, 3_000);
      }
      if (process.exitCode === null && process.signalCode === null) {
        process.kill("SIGKILL");
        await waitForExit(process, 2_000);
      }
    }
    this.ownsRunner = false;

    const tunnelCleanup = this.tunnelCleanup;
    this.tunnelCleanup = undefined;
    await tunnelCleanup?.();
  }
}

function asRecord(value: unknown): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new MengineRuntimeError("execution_error", "expected a JSON object", value);
  }
  return value as JsonRecord;
}

function expandVariables(value: string, variables: Record<string, string>): string {
  return value.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/gu, (match, key: string) => variables[key] ?? match);
}

function resolveAutomationCommand(descriptor: LoadedDescriptor, command: string): string {
  if (path.isAbsolute(command)) {
    return command;
  }
  if (command.startsWith(".") || command.includes("/") || command.includes("\\")) {
    return resolveDescriptorPath(descriptor, command);
  }
  return command;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await Promise.race([
    new Promise<void>(resolve => child.once("exit", () => resolve())),
    delay(timeoutMs),
  ]);
}
