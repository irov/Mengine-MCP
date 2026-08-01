export const DESCRIPTOR_FILE_NAME = "mengine.mcp.json";
export const MCP_PROVIDER_ID = "mengine.mcp";
export const CREATE_CONFIGURATION_COMMAND = "mengineMcp.createConfiguration";
export const OPEN_CONFIGURATION_COMMAND = "mengineMcp.openConfiguration";

export function makeServerLabel(workspaceName: string): string {
  return `Mengine MCP: ${workspaceName}`;
}

export function makeServerVersion(extensionVersion: string, descriptorModifiedAt: number): string {
  return `${extensionVersion}:${descriptorModifiedAt}`;
}
