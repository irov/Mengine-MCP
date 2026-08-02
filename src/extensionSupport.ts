export const DESCRIPTOR_DIRECTORY_NAME = ".mengine";
export const DESCRIPTOR_FILE_NAME = "mcp.json";
export const DESCRIPTOR_RELATIVE_PATH = `${DESCRIPTOR_DIRECTORY_NAME}/${DESCRIPTOR_FILE_NAME}`;
export const MENGINE_GITIGNORE_FILE_NAME = ".gitignore";
export const MCP_PROVIDER_ID = "mengine.mcp";
export const CREATE_CONFIGURATION_COMMAND = "mengineMcp.createConfiguration";
export const OPEN_CONFIGURATION_COMMAND = "mengineMcp.openConfiguration";
export const CONNECT_CODEX_COMMAND = "mengineMcp.connectCodex";
export const DISCONNECT_CODEX_COMMAND = "mengineMcp.disconnectCodex";
export const SHOW_CODEX_STATUS_COMMAND = "mengineMcp.showCodexStatus";

export function makeServerLabel(workspaceName: string): string {
  return `Mengine MCP: ${workspaceName}`;
}

export function makeServerVersion(extensionVersion: string, descriptorModifiedAt: number): string {
  return `${extensionVersion}:${descriptorModifiedAt}`;
}

export function mergeMengineGitignore(source: string): string {
  const required = [".cache/", "local.json"];
  const lines = source.split(/\r?\n/u);
  const missing = required.filter(rule => !lines.some(line => line.trim() === rule));
  if (missing.length === 0) {
    return source;
  }

  const prefix = source.length === 0 || source.endsWith("\n") ? source : `${source}\n`;
  return `${prefix}${missing.join("\n")}\n`;
}
