# Mengine MCP

[![CI](https://github.com/irov/Mengine-MCP/actions/workflows/ci.yml/badge.svg)](https://github.com/irov/Mengine-MCP/actions/workflows/ci.yml)
[![Visual Studio Marketplace](https://img.shields.io/visual-studio-marketplace/v/wonderland.mengine-mcp)](https://marketplace.visualstudio.com/items?itemName=wonderland.mengine-mcp)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Give your AI agent a live connection to your game.** Mengine MCP lets Visual Studio Code launch, inspect, control, debug, and hot-reload Development builds made with the open-source [Mengine game engine](https://github.com/irov/Mengine).

Instead of reasoning from source alone, an agent can click UI, inject touch and keyboard input, inspect the active scene, capture frames, read logs, evaluate Python, stop on script breakpoints, and verify changes inside the running game.

## Highlights

- Launch existing desktop and mobile builds in visible, hidden-render, or headless-logic mode.
- Inspect and edit the live scene using generation-safe node handles.
- Inject deterministic mouse, keyboard, and multi-touch sequences without moving the system cursor.
- Capture frames, read logs and diagnostics, and wait for runtime conditions.
- Inspect, evaluate, and mutate Python state, including paused debugger frames.
- Explicitly hot-reload Python modules and resource overlays with rollback on failure.
- Extend the public tool surface from game-side C++ or Python handlers.

Mengine MCP does not build the game. It launches artifacts produced by your normal Mengine, IDE, or CI build workflow.

## Install in Visual Studio Code

Install **Mengine MCP** from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=wonderland.mengine-mcp), or install a locally built VSIX:

```sh
code --install-extension mengine-mcp-0.1.0.vsix
```

The VSIX contains both the extension and the STDIO MCP server. Users do not need to install a separate Node.js runtime.

## Configure a game

1. Build the game in Development mode with `MCPPlugin` enabled. The plugin must remain excluded from Master and Release builds.
2. Open the game root in VS Code.
3. Run `Mengine MCP: Create Configuration` from the Command Palette.
4. Edit the generated `mengine.mcp.json` with the commands and paths for the game.
5. Open Chat in agent mode. VS Code automatically discovers `Mengine MCP: <workspace>`.

The descriptor is resolved relative to the game root. A minimal desktop profile looks like this:

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
          "command": "./build/Debug/MyGame.app/Contents/MacOS/MyGame"
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

See [mengine.mcp.example.json](mengine.mcp.example.json) for desktop and Android profiles. Android launch profiles receive the listener endpoint and session token as Intent extras, and can use `portForwardCommand` for `adb reverse`.

## Run the STDIO server directly

The server also works with Codex and other MCP clients independently of VS Code:

```sh
npm ci
npm run build
node dist/mengine-mcp.mjs --config /path/to/game/mengine.mcp.json
```

It speaks standard MCP over STDIO and connects to the running game through the authenticated `MNCP v1` TCP protocol.

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
