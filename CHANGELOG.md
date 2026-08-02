# Changelog

## 0.2.0

- Automatically maintain a global managed Codex server from trusted workspaces containing `mengine.mcp.json`.
- Resolve the Codex CLI from user configuration, environment, installed OpenAI extensions/apps, or `PATH` on macOS, Windows, and Linux.
- Update managed registrations after VSIX upgrades while preserving unmanaged servers with the same name.
- Add `Connect Codex`, `Disconnect Codex`, and `Show Codex Status` recovery commands.
- Discover project configuration from `--config`, `MENGINE_MCP_CONFIG`, or the Codex session working directory.
- Publish only read-only `mengine_status` when no project descriptor is available.
- Report clean application exits as stopped even when the runtime socket closes before the process exit event.

## 0.1.0

- Add the standalone Mengine MCP STDIO server and `MNCP v1` runtime bridge.
- Register Mengine MCP in VS Code for every workspace containing `mengine.mcp.json`.
- Add a command that creates a starter configuration for a game workspace.
- Package the extension and server together as a platform-independent VSIX.
