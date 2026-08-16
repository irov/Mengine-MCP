# Changelog

## Unreleased

- Add lightweight XCTest UI runner-backed `ios_ui_*` tools for physical-screen taps, accessibility elements, hardware buttons, screenshots, and native/system alerts without Appium or WebDriverAgent.

## 0.3.5

- Add automatic LLDB/CoreDevice USB tunnels for physical iOS launch profiles, including dynamic tunnel-host discovery and session cleanup.
- Fix non-empty input sequences being rejected before execution.

## 0.3.4

- Add raw accelerometer input and a high-level shake command for physical-device motion automation.
- Allow machine-local descriptor variables for device identifiers, LAN hosts, and local build paths.

## 0.3.3

- Add profile-scoped managed macOS builds under `.mengine/.cache/build/<profileId>` with explicit `app_build` and `app_clean` tools.
- Allow launch profiles to use a managed build instead of a committed executable path.
- Create `.mengine/.gitignore` rules for the disposable build cache and machine-local `local.json`.
- Stage an ephemeral ad-hoc-signed macOS launch copy outside SMB volumes and remove it with the session lifecycle.
- Prefer silent hidden-render launches and offscreen frame capture in the MCP guidance exposed to Codex.
- Pass authenticated MCP endpoint options and `--cli` directly to command-line runtimes; stop using legacy runtime endpoint environment variables.
- Keep Android, iOS, and iOS Simulator sessions alive after their launcher command exits, with optional `stopCommand` cleanup.
- Reconcile the managed global Codex registration from every trusted workspace so installed VSIX updates cannot leave a deleted bundle path behind.

## 0.3.2

- Use the existing desktop `--cli` launch argument for silent-dialog behavior in hidden and headless modes; no separate environment variable is introduced.

## 0.3.1

- Pass the existing `--cli` argument to hidden and headless desktop runtimes so hosts suppress modal startup failures before MCP initialization.

## 0.3.0

- Store the only supported game descriptor at `.mengine/mcp.json` instead of the workspace root.
- Resolve descriptor commands and source roots relative to the game workspace rather than the hidden configuration directory.
- Create and watch the `.mengine` directory from the VS Code extension; legacy root descriptors are not discovered.

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
