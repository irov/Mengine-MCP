# Mengine MCP

[![CI](https://github.com/irov/Mengine-MCP/actions/workflows/ci.yml/badge.svg)](https://github.com/irov/Mengine-MCP/actions/workflows/ci.yml)
[![Visual Studio Marketplace](https://img.shields.io/visual-studio-marketplace/v/wonderland.mengine-mcp)](https://marketplace.visualstudio.com/items?itemName=wonderland.mengine-mcp)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Give your AI agent a live connection to your game.** Mengine MCP lets Visual Studio Code launch, inspect, control, debug, and hot-reload Development builds made with the open-source [Mengine game engine](https://github.com/irov/Mengine).

Instead of reasoning from source alone, an agent can click UI, inject touch and keyboard input, inspect the active scene, capture frames, read logs, evaluate Python, stop on script breakpoints, and verify changes inside the running game.

## Highlights

- Build managed macOS Development profiles into a workspace-local cache.
- Launch managed or existing desktop and mobile builds in visible, hidden-render, or headless-logic mode.
- Inspect and edit the live scene using generation-safe node handles.
- Inject deterministic mouse, keyboard, and multi-touch sequences without moving the system cursor.
- Drive native UIKit controls and iOS system alerts on physical devices through a lightweight XCTest UI runner.
- Capture frames, read logs and diagnostics, and wait for runtime conditions.
- Inspect, evaluate, and mutate Python state, including paused debugger frames.
- Explicitly hot-reload Python modules and resource overlays with rollback on failure.
- Extend the public tool surface from game-side C++ or Python handlers.

Mengine MCP can incrementally build managed macOS Development profiles. Other platforms can continue to launch artifacts produced by the normal Mengine, IDE, or CI build workflow.

## Install in Visual Studio Code

Install **Mengine MCP** from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=wonderland.mengine-mcp), or install a locally built VSIX:

```sh
code --install-extension mengine-mcp-0.3.5.vsix
```

The VSIX contains both the extension and the STDIO MCP server. Users do not need to install a separate Node.js runtime.

## Configure a game

1. Configure a Development profile with `MCPPlugin` enabled. The plugin must remain excluded from Master and Release builds.
2. Open the game root in VS Code.
3. Run `Mengine MCP: Create Configuration` from the Command Palette.
4. Edit the generated `.mengine/mcp.json` with the build or launch profiles and source mappings for the game.
5. Open Chat in agent mode. VS Code automatically discovers `Mengine MCP: <workspace>`.

The extension never launches the game when a workspace opens. It only publishes MCP tools; the agent launches an existing Development artifact when a runtime, frame, input, scene, or log check is actually needed.

The descriptor lives at `.mengine/mcp.json`. Build deploy paths, launch paths, script roots, and asset roots are resolved relative to the game root, not the hidden `.mengine` directory. A minimal managed macOS profile looks like this:

```json
{
  "version": 1,
  "apps": [
    {
      "id": "game",
      "name": "My Mengine Game",
      "profiles": [
        {
          "id": "macos-dev",
          "platform": "macos",
          "build": {
            "provider": "mengine",
            "configuration": "Debug",
            "deployPath": "./Deploy/MacOS"
          }
        }
      ],
      "scriptRoots": [
        {
          "path": "./Scripts",
          "logicalPrefix": "Scripts"
        }
      ],
      "assetRoots": [
        {
          "path": "./Resources",
          "fileGroup": "game"
        }
      ]
    }
  ]
}
```

Managed builds also need a machine-local `.mengine/local.json`. This file is never committed:

```json
{
  "engineRoot": "/local/path/to/Mengine"
}
```

The extension creates `.mengine/.gitignore` with rules for `local.json` and `.cache/`. Each profile reuses exactly one build directory:

```text
.mengine/.cache/build/<profileId>/
├── solution/
├── output/
├── runtime/
├── build.log
└── state.json
```

Use `app_build` for an incremental build and then `app_launch`. Rebuilding overwrites the same profile cache; Mengine MCP does not retain generations or copies of previous artifacts. A failed rebuild marks the current state as `failed` while retaining the previous build metadata in `lastSuccessful`; because the output directory is shared, this is a record rather than an artifact rollback guarantee. For macOS launch, Mengine MCP creates one ad-hoc-signed copy in the local system temporary directory so builds stored on SMB volumes can run despite server-managed extended attributes; it removes that copy on stop, exit, failed launch, rebuild, or clean. `app_clean` removes only the selected profile directory and any temporary launch copy. Managed builds currently support macOS; the profile-scoped layout reserves separate directories for iOS, iOS Simulator, and Android providers.

Machine-specific descriptor values such as a physical-device identifier or the Mac's LAN address belong in ignored `.mengine/local.json` under `variables`. Reference them as `{variableName}` from `.mengine/mcp.json`; unresolved local variables fail descriptor loading, while managed runtime placeholders such as `{mcpPort}` remain available at launch.

Physical iOS profiles can use an automatic CoreDevice USB tunnel, so they do not depend on Wi-Fi addresses or Local Network permission:

```json
{
  "id": "ios-device-debug",
  "platform": "ios",
  "command": "xcrun",
  "args": [
    "devicectl", "device", "process", "launch",
    "--device", "{iosDeviceId}",
    "--terminate-existing",
    "com.example.game"
  ],
  "coreDeviceTunnel": {
    "deviceId": "{iosDeviceId}"
  }
}
```

Mengine MCP opens an LLDB/CoreDevice keepalive for the session, discovers the transient Mac-side IPv6 address, and closes the tunnel after `app_stop`. Store only `iosDeviceId` in `.mengine/local.json`; the tunnel address must not be committed or cached because CoreDevice changes it between connections.

Engine input commands cannot reach UIKit views placed above the game or system-owned permission dialogs. Add `iosUiAutomation` to an iOS profile when the agent must inspect accessibility state, tap native controls, or accept/dismiss alerts on a physical device:

```json
{
  "iosUiAutomation": {
    "provider": "xctest",
    "deviceId": "{iosDeviceId}",
    "targetBundleId": "com.example.game",
    "runnerCommand": [
      "xcodebuild",
      "-project", "{iosUiRunnerProject}",
      "-scheme", "MengineMCPUIAutomation",
      "-configuration", "Debug",
      "-destination", "id={iosDeviceId}",
      "-derivedDataPath", "{iosUiDerivedData}",
      "-allowProvisioningUpdates",
      "-allowProvisioningDeviceRegistration",
      "DEVELOPMENT_TEAM={appleDevelopmentTeam}",
      "CODE_SIGN_STYLE=Automatic",
      "COMPILER_INDEX_STORE_ENABLE=NO",
      "MENGINE_MCP_UI_HOST={iosUiHost}",
      "MENGINE_MCP_UI_PORT={iosUiPort}",
      "MENGINE_MCP_UI_TOKEN={iosUiToken}",
      "MENGINE_MCP_UI_TARGET_BUNDLE_ID={iosUiTargetBundleId}",
      "test"
    ],
    "startupTimeoutMs": 300000,
    "requestTimeoutMs": 60000
  }
}
```

The standalone runner project is included at `ios/MengineMCPUIAutomation`; it uses only Xcode, XCTest, and XCUIAutomation and is not linked into the game or submitted to the App Store. Store the device, signing team, absolute runner-project path, and a derived-data path in ignored `.mengine/local.json`. Call `ios_ui_start` before recording or launching the tested app so runner installation is not visible in the user flow. `ios_ui_snapshot`, `ios_ui_screenshot`, `ios_ui_tap`, `ios_ui_tap_element`, `ios_ui_press_button`, and `ios_ui_alert` can then reach native and system-owned UI. Always finish with `ios_ui_stop`.

See [mengine.mcp.example.json](mengine.mcp.example.json) for desktop and Android profiles. Android launch profiles receive the listener endpoint and session token as Intent extras, and can use `portForwardCommand` for `adb reverse`. Detached Android, iOS, and iOS Simulator launchers may also define a `stopCommand` fallback. `app_stop` first requests orderly shutdown over MNCP and uses that command only when the runtime is disconnected or does not stop before the timeout.

Command-line profiles receive `--mcp`, the authenticated `--mcp-host`, `--mcp-port`, `--mcp-token`, and `--mcp-mode` options, plus `--cli`. Mengine treats `--cli` as silent automation: desktop hosts suppress modal startup dialogs and the Bootstrapper selects `SilentSoundSystem`, so even an explicitly visible MCP launch has no game audio. `app_launch` defaults to `hidden_render`; `visible` remains an explicit interactive escape hatch. Android keeps its Intent-extra transport.

`frame_capture` renders into an engine-owned offscreen target and encodes that target as PNG. It does not use an OS screenshot and does not require the game, Xcode, or Simulator window to be open, visible, focused, or frontmost. Only `headless_logic`, which has no renderer, cannot capture frames.

## Automatic Codex connection

Whenever the installed extension activates in a trusted workspace, it also maintains a global Codex MCP server named `mengine`. Reconciliation does not require the current workspace to contain `.mengine/mcp.json`; an unconfigured server safely exposes only `mengine_status`. No terminal command, project-local server source, `.codex/config.toml`, or versioned VSIX path is required.

The managed registration launches the server bundled in the currently installed extension through the VS Code runtime. After the first registration, start a new Codex agent or restart the Codex extension if the running agent does not refresh its MCP configuration. Later workspace opens and VSIX updates are reconciled automatically.

An existing `mengine` registration without the `wonderland.mengine-mcp` management marker is preserved. Use these Command Palette recovery actions to inspect or explicitly change registration state:

- `Mengine MCP: Show Codex Status`
- `Mengine MCP: Connect Codex`
- `Mengine MCP: Disconnect Codex`

Automatic registration and recovery commands are disabled in untrusted workspaces. Failure to locate Codex does not affect the existing VS Code Chat MCP provider.

## Guide Codex to prefer Mengine MCP

The MCP server publishes an MCP-first workflow in its server-wide instructions. The critical guidance is self-contained within the first 512 characters, following the [official OpenAI MCP guidance](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

For a fallback that still applies when the MCP server failed to load, merge the following block into the game's root `AGENTS.md`:

```md
## Mengine runtime workflow

- Before direct runtime, GUI, Xcode, Simulator, or OS screenshot actions, call `mengine_status` and `app_list` and prefer Mengine MCP.
- Build managed profiles with `app_build`; launch with the default `hidden_render` mode and capture with `frame_capture`.
- `frame_capture` renders offscreen. The game or Simulator window does not need to be open, visible, focused, or frontmost.
- Use `visible` only when the user explicitly requests interactive foreground behavior.
- Fall back to direct tools only when MCP is unavailable or reports the operation unsupported, and state that fallback explicitly.
- If `mengine_status` is absent, report that Codex registration or a fresh Codex session is required; do not silently open Xcode, Simulator, or the game GUI.
- Always call `app_stop` after runtime work.
```

Codex discovers `AGENTS.md` from the project root down to the current working directory, so this file belongs at the game root rather than under `.mengine`; see the [official OpenAI `AGENTS.md` guide](https://learn.chatgpt.com/docs/agent-configuration/agents-md). The extension never creates or overwrites this project instruction file. After a registration or VSIX update, start a new Codex agent because active sessions retain their original tool inventory.

## Run the STDIO server directly

The server also works with other MCP clients independently of VS Code:

```sh
npm ci
npm run build
node dist/mengine-mcp.mjs --config /path/to/game/.mengine/mcp.json
```

Configuration discovery uses this order: explicit `--config`, `MENGINE_MCP_CONFIG`, then an upward search for `.mengine/mcp.json` from the MCP process working directory. Root-level `mengine.mcp.json` files are not supported. An explicitly missing `--config` remains an error. Without any discovered descriptor, the server starts normally and publishes only the read-only `mengine_status` tool, so its global Codex registration does not expose game controls in unrelated projects.

It speaks standard MCP over STDIO and connects to the running game through the authenticated `MNCP v1` TCP protocol. It builds only explicit managed profiles and can install or launch only configured applications. It never signs, archives, uploads, deploys, or publishes an application.

## Development

```sh
npm ci
npm test
npm run package
```

`npm run package` creates a platform-independent VSIX. Tagged `v*` releases are verified and published by the Release GitHub Actions workflow using the `VSCE_PAT` repository secret.

## Safety

This extension intentionally has powerful Development-only capabilities, including application launch commands and unrestricted Python execution. VS Code therefore disables it in untrusted workspaces. Session tokens are generated per launch and must never be logged or committed.

See [SECURITY.md](SECURITY.md) for the complete security boundary.

## Related project

[Mengine](https://github.com/irov/Mengine) is a multi-platform C++ game engine used to build and ship graphical games across desktop and mobile platforms. Mengine MCP is its AI-agent development companion.
