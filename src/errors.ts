export type MengineRuntimeErrorCode =
  | "unsupported"
  | "script_unavailable"
  | "stale_handle"
  | "runtime_paused"
  | "timeout"
  | "execution_error"
  | "restart_required"
  | "build_required"
  | "build_in_progress"
  | "disconnected"
  | "authentication_failed"
  | "invalid_request";

export class MengineRuntimeError extends Error {
  public constructor(
    public readonly code: MengineRuntimeErrorCode,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = "MengineRuntimeError";
  }
}

export function errorResult(error: unknown): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  const value = error instanceof MengineRuntimeError
    ? { code: error.code, message: error.message, data: error.data }
    : { code: "execution_error", message: error instanceof Error ? error.message : String(error) };

  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    isError: true,
  };
}

export function successResult(value: unknown): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
} {
  const structuredContent = isRecord(value) ? value : { value };
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
