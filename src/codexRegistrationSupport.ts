export const CODEX_MCP_SERVER_NAME = "mengine";
export const CODEX_MCP_MANAGED_BY = "wonderland.mengine-mcp";

export type CodexMcpConfiguration = {
  enabled?: boolean;
  name?: string;
  transport?: {
    args?: string[];
    command?: string;
    env?: Record<string, string>;
    type?: string;
  };
};

export type RegistrationDisposition = "missing" | "current" | "stale" | "unmanaged";

export function makeManagedRegistrationArgs(
  executable: string,
  serverPath: string,
  version: string,
): string[] {
  return [
    "mcp",
    "add",
    CODEX_MCP_SERVER_NAME,
    "--env",
    "ELECTRON_RUN_AS_NODE=1",
    "--env",
    `MENGINE_MCP_VERSION=${version}`,
    "--",
    executable,
    serverPath,
    "--managed-by",
    CODEX_MCP_MANAGED_BY,
  ];
}

export function classifyRegistration(
  configuration: CodexMcpConfiguration | undefined,
  executable: string,
  serverPath: string,
  version: string,
): RegistrationDisposition {
  if (configuration === undefined) {
    return "missing";
  }

  if (!isManagedConfiguration(configuration)) {
    return "unmanaged";
  }

  return isCurrentConfiguration(configuration, executable, serverPath, version)
    ? "current"
    : "stale";
}

export function isManagedConfiguration(configuration: CodexMcpConfiguration): boolean {
  const args = configuration.transport?.args ?? [];
  const markerIndex = args.indexOf("--managed-by");
  return markerIndex >= 0 && args[markerIndex + 1] === CODEX_MCP_MANAGED_BY;
}

export function isCurrentConfiguration(
  configuration: CodexMcpConfiguration,
  executable: string,
  serverPath: string,
  version: string,
): boolean {
  return configuration.transport?.type === "stdio"
    && configuration.transport.command === executable
    && configuration.transport.args?.[0] === serverPath
    && configuration.transport.env?.ELECTRON_RUN_AS_NODE === "1"
    && configuration.transport.env?.MENGINE_MCP_VERSION === version
    && isManagedConfiguration(configuration);
}

export function isMissingMcpConfigurationError(error: unknown): boolean {
  if (error === null || typeof error !== "object") {
    return false;
  }

  const candidate = error as { code?: number | string; stderr?: string; stdout?: string };
  const text = `${candidate.stderr ?? ""}\n${candidate.stdout ?? ""}`.toLowerCase();
  return candidate.code === 1 && (text.includes("not found") || text.includes("no mcp server"));
}

export function isExecutableUnavailableError(error: unknown): boolean {
  return Boolean(
    error !== null
    && typeof error === "object"
    && "code" in error
    && (error.code === "ENOENT" || error.code === "EACCES"),
  );
}
