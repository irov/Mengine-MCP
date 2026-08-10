declare const __MENGINE_MCP_VERSION__: string | undefined;

export const MENGINE_MCP_VERSION = typeof __MENGINE_MCP_VERSION__ === "string"
  ? __MENGINE_MCP_VERSION__
  : "0.3.3";
