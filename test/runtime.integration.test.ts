import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { loadDescriptor } from "../src/descriptor.js";
import { MengineRuntimeError } from "../src/errors.js";
import { SessionManager, type LaunchMode } from "../src/session.js";

const descriptorPath = process.env.MENGINE_MCP_INTEGRATION_DESCRIPTOR;
const appId = process.env.MENGINE_MCP_INTEGRATION_APP;
const profileId = process.env.MENGINE_MCP_INTEGRATION_PROFILE;
const enabled = descriptorPath !== undefined && appId !== undefined && profileId !== undefined;

type DebugStack = {
  generation?: number;
  frames?: Array<{ id?: string; filename?: string; line?: number }>;
};

async function waitForDebugStack(manager: SessionManager, applicationId: string, afterGeneration = 0): Promise<DebugStack> {
  const deadline = Date.now() + 5_000;

  while (Date.now() < deadline) {
    try {
      const stack = await manager.request(applicationId, "debug_stack", {}) as DebugStack;
      if ((stack.generation ?? 0) > afterGeneration) {
        return stack;
      }
    } catch (error) {
      if (!(error instanceof MengineRuntimeError) || error.code !== "execution_error") {
        throw error;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  throw new MengineRuntimeError("timeout", "timed out waiting for a new debugger pause generation");
}

for (const mode of ["visible", "hidden_render", "headless_logic"] as const satisfies readonly LaunchMode[]) {
  test(`runtime integration: ${mode}`, { skip: !enabled, timeout: 60_000 }, async () => {
    const manager = new SessionManager(await loadDescriptor(descriptorPath!));

    try {
      const launched = await manager.launch(appId!, profileId!, mode);
      assert.equal(launched.requestedPlatform, "macos");
      assert.equal(launched.effectivePlatform, "macos");

      const diagnostics = await manager.request(appId!, "diagnostics_get", {}, 30_000) as { mode?: string; connected?: boolean };
      assert.equal(diagnostics.mode, mode);
      assert.equal(diagnostics.connected, true);

      const evaluated = await manager.request(appId!, "script_eval", {
        expression: "1 + 2",
        scope: "globals",
      }) as { value?: unknown };
      assert.equal(evaluated.value, 3);

      await manager.request(appId!, "script_exec", {
        code: "import Mengine\nmcp_command_value = 0\ndef mcp_integration_query(arguments, offset):\n    return {'value': arguments['value'] + offset}\ndef mcp_integration_command(arguments, multiplier):\n    global mcp_command_value\n    mcp_command_value = arguments['value'] * multiplier\n    return {'value': mcp_command_value}\nmcp_query_handler = Mengine.mcpAddHandler('integration.echo', mcp_integration_query, 3)\nmcp_command_handler = Mengine.mcpAddHandler('integration.store', mcp_integration_command, 2)\n",
        filename: "mcp/handler-integration.py",
        scope: "globals",
      });
      const registered = await manager.request(appId!, "script_eval", {
        expression: "mcp_query_handler is not None and mcp_command_handler is not None",
        scope: "globals",
      }) as { value?: unknown };
      assert.equal(registered.value, true);

      const scriptQuery = await manager.request(appId!, "script_call", {
        name: "integration.echo",
        arguments: { value: 17 },
      }) as { value?: unknown };
      assert.equal(scriptQuery.value, 20);

      const scriptCommand = await manager.request(appId!, "script_call", {
        name: "integration.store",
        arguments: { value: 11 },
      }) as { value?: unknown };
      assert.equal(scriptCommand.value, 22);

      const commandValue = await manager.request(appId!, "script_eval", {
        expression: "mcp_command_value",
        scope: "globals",
      }) as { value?: unknown };
      assert.equal(commandValue.value, 22);

      await manager.request(appId!, "script_exec", {
        code: "Mengine.mcpRemoveHandler(mcp_query_handler)\nMengine.mcpRemoveHandler(mcp_command_handler)\n",
        filename: "mcp/handler-integration.py",
        scope: "globals",
      });
      await assert.rejects(
        () => manager.request(appId!, "script_call", {
          name: "integration.echo",
          arguments: { value: 17 },
        }),
        (error: unknown) => error instanceof MengineRuntimeError && error.code === "execution_error",
      );
      await assert.rejects(
        () => manager.request(appId!, "script_call", {
          name: "integration.store",
          arguments: { value: 11 },
        }),
        (error: unknown) => error instanceof MengineRuntimeError && error.code === "execution_error",
      );

      await manager.request(appId!, "input_mouse", {
        action: "move",
        x: 0.5,
        y: 0.5,
        coordinateSpace: "normalized",
      });

      await manager.request(appId!, "runtime_control", { action: "pause" });
      await manager.request(appId!, "runtime_control", { action: "resume" });

      if (mode === "hidden_render") {
        await manager.request(appId!, "script_exec", {
          code: "value = 7\ndef __mcp_before_reload__():\n    return value\n",
          filename: "mcp/integration-bootstrap.py",
          scope: "globals",
        });
        await manager.request(appId!, "debug_set_breakpoints", {
          filename: "mcp/integration.py",
          breakpoints: [{ line: 200, enabled: true }],
        });

        const reloadSource = Buffer.from(
          "value = 100\ndef __mcp_after_reload__(state):\n    global value\n    value = state + 1\n",
          "utf8",
        );
        const reload = await manager.request(appId!, "script_reload_module", {
          module: "__mcp_globals__",
          logicalPath: "mcp/integration.py",
          modulePath: "integration.py",
          encoding: "utf-8",
        }, 10_000, reloadSource) as {
          reloaded?: boolean;
          identityPreserved?: boolean;
          breakpointsDisabled?: number[];
        };
        assert.equal(reload.reloaded, true);
        assert.equal(reload.identityPreserved, true);
        assert.equal(reload.breakpointsDisabled?.length, 1);

        const afterReload = await manager.request(appId!, "script_eval", {
          expression: "value",
          scope: "globals",
        }) as { value?: unknown };
        assert.equal(afterReload.value, 8, "reload hooks transfer state");

        await assert.rejects(
          () => manager.request(appId!, "script_reload_module", {
            module: "__mcp_globals__",
            logicalPath: "mcp/integration.py",
            modulePath: "integration.py",
            encoding: "utf-8",
          }, 10_000, Buffer.from("value =\n", "utf8")),
          (error: unknown) => error instanceof MengineRuntimeError && error.code === "execution_error",
        );
        const afterFailedReload = await manager.request(appId!, "script_eval", {
          expression: "value",
          scope: "globals",
        }) as { value?: unknown };
        assert.equal(afterFailedReload.value, 8, "failed reload preserves the live dictionary");

        const sessionSource = await manager.request(appId!, "script_source", {
          module: "__mcp_globals__",
        }) as { kind?: string; source?: string };
        assert.equal(sessionSource.kind, "session_source");
        assert.equal(sessionSource.source, reloadSource.toString("utf8"));

        await manager.request(appId!, "debug_set_breakpoints", {
          filename: "mcp/debug-integration.py",
          breakpoints: [{ line: 3, enabled: true }],
        });
        const debugExecution = manager.request(appId!, "script_exec", {
          code: "def debug_target():\n    value = 1\n    value = value + 1\n    value = value + 1\n    return value\ndebug_result = debug_target()\n",
          filename: "mcp/debug-integration.py",
          scope: "globals",
        }, 10_000);
        const firstStack = await waitForDebugStack(manager, appId!);
        assert.ok((firstStack.generation ?? 0) > 0);
        assert.equal(firstStack.frames?.[0]?.filename, "mcp/debug-integration.py");
        assert.equal(firstStack.frames?.[0]?.line, 3);
        const frameId = firstStack.frames?.[0]?.id;
        assert.ok(frameId);

        const scopes = await manager.request(appId!, "debug_scopes", { frameId }) as {
          scopes?: Array<{ name?: string; handle?: number }>;
        };
        const localsHandle = scopes.scopes?.find((scope) => scope.name === "locals")?.handle;
        assert.ok(localsHandle);
        const variables = await manager.request(appId!, "debug_variables", {
          handle: localsHandle,
          start: 1,
          count: 1,
        }) as { start?: number; count?: number; value?: Record<string, unknown> };
        assert.equal(variables.start, 1);
        assert.equal(variables.count, 1);
        assert.ok(Object.keys(variables.value ?? {}).length <= 1);

        await manager.request(appId!, "debug_set_variable", {
          frameId,
          scope: "locals",
          name: "value",
          value: 40,
        });

        const debugEvaluation = await manager.request(appId!, "debug_evaluate", {
          frameId,
          expression: "value",
        }) as { value?: unknown };
        assert.equal(debugEvaluation.value, 40);

        await manager.request(appId!, "debug_step", { kind: "over" });
        const steppedStack = await waitForDebugStack(manager, appId!, firstStack.generation);
        assert.ok((steppedStack.generation ?? 0) > (firstStack.generation ?? 0));
        assert.equal(steppedStack.frames?.[0]?.line, 4);
        const steppedFrameId = steppedStack.frames?.[0]?.id;
        assert.ok(steppedFrameId);
        const steppedEvaluation = await manager.request(appId!, "debug_evaluate", {
          frameId: steppedFrameId,
          expression: "value",
        }) as { value?: unknown };
        assert.equal(steppedEvaluation.value, 41);
        await manager.request(appId!, "debug_continue", {});
        await debugExecution;

        const afterDebug = await manager.request(appId!, "script_eval", {
          expression: "debug_result",
          scope: "globals",
        }) as { value?: unknown };
        assert.equal(afterDebug.value, 42);

        const assetPath = process.env.MENGINE_MCP_INTEGRATION_ASSET;
        const assetGroup = process.env.MENGINE_MCP_INTEGRATION_ASSET_GROUP;
        const assetLogicalPath = process.env.MENGINE_MCP_INTEGRATION_ASSET_LOGICAL_PATH;
        if (assetPath !== undefined && assetGroup !== undefined && assetLogicalPath !== undefined) {
          const asset = await readFile(assetPath);
          const resourceReload = await manager.request(appId!, "resource_reload", {
            entries: [{ fileGroup: assetGroup, logicalPath: assetLogicalPath, offset: 0, size: asset.length }],
          }, 10_000, asset) as { results?: Array<{ status?: string }> };
          assert.equal(resourceReload.results?.[0]?.status, "reloaded");

          const resourceRevert = await manager.request(appId!, "resource_revert", {
            resources: [{ fileGroup: assetGroup, logicalPath: assetLogicalPath }],
          }) as { results?: Array<{ status?: string }> };
          assert.equal(resourceRevert.results?.[0]?.status, "reloaded");
        }
      }

      if (mode === "headless_logic") {
        await assert.rejects(
          () => manager.request(appId!, "frame_capture", {}, 10_000),
          (error: unknown) => error instanceof MengineRuntimeError && error.code === "unsupported",
        );
      } else {
        const capture = await manager.request(appId!, "frame_capture", { includeAlpha: false }, 15_000) as {
          response?: { width?: number; height?: number };
          binary?: Buffer;
        };
        assert.ok((capture.response?.width ?? 0) > 0);
        assert.ok((capture.response?.height ?? 0) > 0);
        assert.ok((capture.binary?.length ?? 0) > 8);
        assert.deepEqual(capture.binary?.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      }
    } finally {
      await manager.close();
    }
  });
}
