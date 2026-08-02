import * as childProcess from "node:child_process";
import fs from "node:fs";
import * as util from "node:util";

import * as vscode from "vscode";

import { resolveCodexCliExecutable } from "./codexCli.js";
import {
  CODEX_MCP_SERVER_NAME,
  type CodexMcpConfiguration,
  classifyRegistration,
  isExecutableUnavailableError,
  isManagedConfiguration,
  isMissingMcpConfigurationError,
  makeManagedRegistrationArgs,
} from "./codexRegistrationSupport.js";

const execFile = util.promisify(childProcess.execFile);

export type MengineCodexRegistrationStatus = {
  cliAvailable: boolean;
  cliExecutable: string;
  configured: boolean;
  managed: boolean;
  message: string;
  serverPath: string;
  upToDate: boolean;
};

export class UnmanagedCodexMcpRegistrationError extends Error {
  public constructor() {
    super(`An MCP server named '${CODEX_MCP_SERVER_NAME}' already exists and is not managed by Mengine MCP.`);
  }
}

export class MengineCodexRegistrationManager {
  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
  ) {}

  public get serverPath(): string {
    return this.context.asAbsolutePath("dist/mengine-mcp.mjs");
  }

  public async getStatus(): Promise<MengineCodexRegistrationStatus> {
    const cliExecutable = resolveCodexCliExecutable();
    let configuration: CodexMcpConfiguration | undefined;

    try {
      configuration = await this.getConfiguration();
    } catch (error) {
      if (error instanceof CodexCliUnavailableError) {
        return {
          cliAvailable: false,
          cliExecutable,
          configured: false,
          managed: false,
          message: `Codex CLI is unavailable (${cliExecutable}).`,
          serverPath: this.serverPath,
          upToDate: false,
        };
      }

      throw error;
    }

    const disposition = classifyRegistration(
      configuration,
      process.execPath,
      this.serverPath,
      String(this.context.extension.packageJSON.version),
    );

    if (disposition === "missing") {
      return {
        cliAvailable: true,
        cliExecutable,
        configured: false,
        managed: false,
        message: `Codex MCP server '${CODEX_MCP_SERVER_NAME}' is not registered.`,
        serverPath: this.serverPath,
        upToDate: false,
      };
    }

    return {
      cliAvailable: true,
      cliExecutable,
      configured: true,
      managed: disposition !== "unmanaged",
      message: disposition === "current"
        ? "Mengine MCP is connected to Codex."
        : disposition === "stale"
          ? "Mengine MCP points to an older installed extension build."
          : `Codex MCP server '${CODEX_MCP_SERVER_NAME}' exists but is not managed by this extension.`,
      serverPath: this.serverPath,
      upToDate: disposition === "current",
    };
  }

  public async connect(options: { replaceUnmanaged?: boolean } = {}): Promise<{
    changed: boolean;
    status: MengineCodexRegistrationStatus;
  }> {
    if (!fs.existsSync(this.serverPath)) {
      throw new Error(`Mengine MCP bundle does not exist: ${this.serverPath}. Reinstall the extension.`);
    }

    const current = await this.getConfiguration();
    if (current !== undefined && !isManagedConfiguration(current) && !options.replaceUnmanaged) {
      throw new UnmanagedCodexMcpRegistrationError();
    }

    const disposition = classifyRegistration(
      current,
      process.execPath,
      this.serverPath,
      String(this.context.extension.packageJSON.version),
    );
    if (disposition === "current") {
      return { changed: false, status: await this.getStatus() };
    }

    if (current !== undefined) {
      await this.runCodex(["mcp", "remove", CODEX_MCP_SERVER_NAME]);
    }

    await this.runCodex(makeManagedRegistrationArgs(
      process.execPath,
      this.serverPath,
      String(this.context.extension.packageJSON.version),
    ));

    const status = await this.getStatus();
    if (!status.configured || !status.managed || !status.upToDate) {
      throw new Error("Codex accepted the Mengine MCP registration, but the managed server could not be verified.");
    }

    return { changed: true, status };
  }

  public async disconnect(): Promise<boolean> {
    const current = await this.getConfiguration();
    if (current === undefined) {
      return false;
    }
    if (!isManagedConfiguration(current)) {
      throw new UnmanagedCodexMcpRegistrationError();
    }

    await this.runCodex(["mcp", "remove", CODEX_MCP_SERVER_NAME]);
    return true;
  }

  public async reconcile(): Promise<boolean> {
    try {
      const result = await this.connect();
      if (result.changed) {
        this.output.appendLine(`Updated managed Codex MCP registration to ${this.serverPath}.`);
      }
      return result.changed;
    } catch (error) {
      this.output.appendLine(`Could not reconcile Codex MCP registration: ${formatError(error)}`);
      throw error;
    }
  }

  private async getConfiguration(): Promise<CodexMcpConfiguration | undefined> {
    try {
      const result = await this.runCodex(["mcp", "get", CODEX_MCP_SERVER_NAME, "--json"]);
      return JSON.parse(result.stdout) as CodexMcpConfiguration;
    } catch (error) {
      if (isMissingMcpConfigurationError(error)) {
        return undefined;
      }

      throw error;
    }
  }

  private async runCodex(args: string[]): Promise<{ stderr: string; stdout: string }> {
    const executable = resolveCodexCliExecutable();

    try {
      const result = await execFile(executable, args, {
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      });
      return { stderr: result.stderr, stdout: result.stdout };
    } catch (error) {
      if (isExecutableUnavailableError(error)) {
        throw new CodexCliUnavailableError(executable);
      }

      throw error;
    }
  }
}

class CodexCliUnavailableError extends Error {
  public constructor(public readonly executable: string) {
    super(`Codex CLI is unavailable: ${executable}`);
  }
}

export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
