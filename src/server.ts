import { Buffer } from "node:buffer";
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { errorResult, successResult } from "./errors.js";
import { LaunchMode, SessionManager } from "./session.js";
import { MENGINE_MCP_VERSION } from "./version.js";

const AppIdSchema = z.object({ appId: z.string().min(1) });
const TimeoutSchema = z.number().int().positive().max(300_000).default(10_000);
const MouseStepSchema = z.object({
  type: z.literal("mouse"),
  params: z.object({ action: z.enum(["move", "down", "up", "click", "double_click", "wheel"]), x: z.number().optional(), y: z.number().optional(), coordinateSpace: z.enum(["pixels", "normalized"]).default("normalized"), button: z.string().default("left"), wheel: z.number().default(0), modifiers: z.array(z.string()).default([]) }),
});
const KeyboardStepSchema = z.object({
  type: z.literal("keyboard"),
  params: z.object({ action: z.enum(["down", "up", "press", "text"]), key: z.string().optional(), text: z.string().optional(), modifiers: z.array(z.string()).default([]) }),
});
const TouchStepSchema = z.object({
  type: z.literal("touch"),
  params: z.object({ action: z.enum(["start", "move", "end", "cancel"]), touches: z.array(z.object({ id: z.number().int().nonnegative(), x: z.number(), y: z.number(), pressure: z.number().min(0).max(1).default(1) })).min(1), coordinateSpace: z.enum(["pixels", "normalized"]).default("normalized") }),
});
const WaitConditionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("frames"), frames: z.number().int().positive() }),
  z.object({ type: z.literal("debugger"), paused: z.boolean().default(true) }),
  z.object({ type: z.literal("runtime"), updateFrozen: z.boolean().optional(), renderFrozen: z.boolean().optional() }),
  z.object({ type: z.literal("scene"), name: z.string().optional(), nodeType: z.string().optional() }),
  z.object({ type: z.literal("node"), query: z.record(z.string(), z.unknown()) }),
  z.object({ type: z.literal("log"), contains: z.string().min(1), category: z.string().optional(), after: z.number().int().nonnegative().default(0) }),
  z.object({ type: z.literal("script"), expression: z.string().min(1), scope: z.enum(["module", "globals"]).default("module"), module: z.string().optional() }),
]);
const InputSequenceStepSchema = z.union([
  MouseStepSchema,
  KeyboardStepSchema,
  TouchStepSchema,
  z.object({ type: z.literal("delay"), milliseconds: z.number().int().nonnegative().max(300_000) }),
  z.object({ type: z.literal("frames"), frames: z.number().int().positive().max(10000) }),
  z.object({ type: z.literal("wait"), condition: WaitConditionSchema }),
]);

type RuntimeToolDefinition = {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodObject;
  readOnly: boolean;
};

const runtimeTools: RuntimeToolDefinition[] = [
  {
    name: "scene_snapshot",
    title: "Snapshot Mengine scene",
    description: "Return the live Mengine scene tree and generation-scoped node handles.",
    inputSchema: AppIdSchema.extend({ includeDisabled: z.boolean().default(true), maxDepth: z.number().int().min(0).max(256).default(64) }),
    readOnly: true,
  },
  {
    name: "scene_find",
    title: "Find Mengine nodes",
    description: "Find live scene nodes by name, type, path, or property filters.",
    inputSchema: AppIdSchema.extend({ query: z.record(z.string(), z.unknown()), limit: z.number().int().positive().max(1000).default(100) }),
    readOnly: true,
  },
  {
    name: "scene_get",
    title: "Read Mengine node",
    description: "Read standard and type-specific properties from a generation-scoped node handle.",
    inputSchema: AppIdSchema.extend({ handle: z.string().min(3), properties: z.array(z.string()).optional() }),
    readOnly: true,
  },
  {
    name: "scene_set",
    title: "Change Mengine node",
    description: "Set supported properties on a generation-scoped live scene node.",
    inputSchema: AppIdSchema.extend({ handle: z.string().min(3), properties: z.record(z.string(), z.unknown()) }),
    readOnly: false,
  },
  {
    name: "input_mouse",
    title: "Inject virtual mouse input",
    description: "Inject mouse move, button, click, double-click, or wheel events through InputService without moving the OS cursor.",
    inputSchema: AppIdSchema.extend({ action: z.enum(["move", "down", "up", "click", "double_click", "wheel"]), x: z.number().optional(), y: z.number().optional(), coordinateSpace: z.enum(["pixels", "normalized"]).default("normalized"), button: z.string().default("left"), wheel: z.number().default(0), modifiers: z.array(z.string()).default([]) }),
    readOnly: false,
  },
  {
    name: "input_keyboard",
    title: "Inject virtual keyboard input",
    description: "Inject key down/up/press or UTF-8 text input through InputService.",
    inputSchema: AppIdSchema.extend({ action: z.enum(["down", "up", "press", "text"]), key: z.string().optional(), text: z.string().optional(), modifiers: z.array(z.string()).default([]) }),
    readOnly: false,
  },
  {
    name: "input_touch",
    title: "Inject virtual touch input",
    description: "Inject one or more touch points using pixel or normalized coordinates.",
    inputSchema: AppIdSchema.extend({ action: z.enum(["start", "move", "end", "cancel"]), touches: z.array(z.object({ id: z.number().int().nonnegative(), x: z.number(), y: z.number(), pressure: z.number().min(0).max(1).default(1) })).min(1), coordinateSpace: z.enum(["pixels", "normalized"]).default("normalized") }),
    readOnly: false,
  },
  {
    name: "input_sequence",
    title: "Run deterministic input sequence",
    description: "Run timed mouse, keyboard, touch, delay, and frame-wait steps in order.",
    inputSchema: AppIdSchema.extend({ steps: z.array(InputSequenceStepSchema).min(1).max(1000), timeoutMs: TimeoutSchema }),
    readOnly: false,
  },
  {
    name: "runtime_control",
    title: "Control Mengine runtime",
    description: "Pause, resume, change time scale, or advance a deterministic number of frames.",
    inputSchema: AppIdSchema.extend({ action: z.enum(["pause", "resume", "time_scale", "advance_frames"]), value: z.number().optional(), frames: z.number().int().positive().max(10000).optional() }),
    readOnly: false,
  },
  {
    name: "diagnostics_get",
    title: "Read Mengine diagnostics",
    description: "Return platform, build, render, scene, script, reload, and debugger diagnostic state.",
    inputSchema: AppIdSchema.extend({ sections: z.array(z.string()).optional() }),
    readOnly: true,
  },
  {
    name: "wait_for",
    title: "Wait for Mengine condition",
    description: "Wait for a scene, node, log, script expression, or frame condition without polling from Codex.",
    inputSchema: AppIdSchema.extend({ condition: WaitConditionSchema, timeoutMs: TimeoutSchema }),
    readOnly: true,
  },
  {
    name: "resource_revert",
    title: "Revert resource overlays",
    description: "Remove selected session resource overlays and rebuild the packaged last-good resources.",
    inputSchema: AppIdSchema.extend({ resources: z.array(z.object({ fileGroup: z.string(), logicalPath: z.string() })).min(1), timeoutMs: TimeoutSchema }),
    readOnly: false,
  },
  {
    name: "script_modules",
    title: "List live Python modules",
    description: "List modules loaded by the active Mengine script runtime.",
    inputSchema: AppIdSchema,
    readOnly: true,
  },
  {
    name: "script_source",
    title: "Read live Python source metadata",
    description: "Return source or PYZ filename/line metadata for a loaded module.",
    inputSchema: AppIdSchema.extend({ module: z.string().min(1) }),
    readOnly: true,
  },
  {
    name: "script_inspect",
    title: "Inspect Python object",
    description: "Inspect a module path or session object handle with bounded depth and item count.",
    inputSchema: AppIdSchema.extend({ target: z.union([z.string(), z.number().int().nonnegative()]), depth: z.number().int().min(0).max(8).default(2), maxItems: z.number().int().positive().max(1000).default(100) }),
    readOnly: true,
  },
  {
    name: "script_get",
    title: "Read Python attribute or item",
    description: "Read an attribute or item from a module path or session object handle.",
    inputSchema: AppIdSchema.extend({ target: z.union([z.string(), z.number().int().nonnegative()]), key: z.union([z.string(), z.number().int()]) }),
    readOnly: true,
  },
  {
    name: "script_set",
    title: "Set Python attribute or item",
    description: "Set an attribute or item on a live Python object.",
    inputSchema: AppIdSchema.extend({ target: z.union([z.string(), z.number().int().nonnegative()]), key: z.union([z.string(), z.number().int()]), value: z.unknown() }),
    readOnly: false,
  },
  {
    name: "script_call",
    title: "Call script handler or Python object",
    description: "Call either a named MCP handler with one JSON argument or a Python callable target with positional arguments and keywords.",
    inputSchema: AppIdSchema.extend({ name: z.string().min(1).optional(), target: z.union([z.string(), z.number().int().nonnegative()]).optional(), arguments: z.unknown().optional(), keywords: z.record(z.string(), z.unknown()).optional(), timeoutMs: TimeoutSchema }),
    readOnly: false,
  },
  {
    name: "script_eval",
    title: "Evaluate Python expression",
    description: "Evaluate an unrestricted Python expression in module, globals, or paused-frame scope.",
    inputSchema: AppIdSchema.extend({ expression: z.string().min(1), scope: z.enum(["module", "globals", "frame"]), module: z.string().optional(), frameId: z.string().optional(), timeoutMs: TimeoutSchema }),
    readOnly: false,
  },
  {
    name: "script_exec",
    title: "Execute Python code",
    description: "Execute unrestricted Python code in module, globals, or paused-frame scope in an authenticated Development session.",
    inputSchema: AppIdSchema.extend({ code: z.string(), scope: z.enum(["module", "globals", "frame"]), module: z.string().optional(), frameId: z.string().optional(), filename: z.string().default("<mcp>"), timeoutMs: TimeoutSchema }),
    readOnly: false,
  },
  {
    name: "script_release",
    title: "Release Python object handles",
    description: "Release session-owned Python object handles.",
    inputSchema: AppIdSchema.extend({ handles: z.array(z.number().int().nonnegative()).min(1) }),
    readOnly: false,
  },
  {
    name: "debug_set_breakpoints",
    title: "Set Python breakpoints",
    description: "Atomically replace breakpoints for a logical Python source file.",
    inputSchema: AppIdSchema.extend({ filename: z.string().min(1), breakpoints: z.array(z.object({ line: z.number().int().positive(), enabled: z.boolean().default(true), condition: z.string().optional(), hitCount: z.number().int().positive().optional(), logMessage: z.string().optional() })) }),
    readOnly: false,
  },
  {
    name: "debug_set_exception_policy",
    title: "Set Python exception break policy",
    description: "Select none, uncaught, or all exception breaks.",
    inputSchema: AppIdSchema.extend({ policy: z.enum(["none", "uncaught", "all"]) }),
    readOnly: false,
  },
  {
    name: "debug_pause",
    title: "Pause Python runtime",
    description: "Request a cooperative pause at the next safe interpreter trace point.",
    inputSchema: AppIdSchema.extend({ timeoutMs: TimeoutSchema }),
    readOnly: false,
  },
  {
    name: "debug_continue",
    title: "Continue Python runtime",
    description: "Continue a Python runtime paused by the MCP debugger.",
    inputSchema: AppIdSchema,
    readOnly: false,
  },
  {
    name: "debug_step",
    title: "Step Python runtime",
    description: "Step in, over, or out from the current paused Python frame.",
    inputSchema: AppIdSchema.extend({ kind: z.enum(["in", "over", "out"]) }),
    readOnly: false,
  },
  {
    name: "debug_stack",
    title: "Read Python call stack",
    description: "Return generation-scoped frame IDs and source locations for the paused script runtime.",
    inputSchema: AppIdSchema,
    readOnly: true,
  },
  {
    name: "debug_scopes",
    title: "Read Python frame scopes",
    description: "Return locals, globals, and builtins scope handles for a paused frame.",
    inputSchema: AppIdSchema.extend({ frameId: z.string().min(1) }),
    readOnly: true,
  },
  {
    name: "debug_variables",
    title: "Read Python debugger variables",
    description: "Read bounded children from a debugger scope or object handle.",
    inputSchema: AppIdSchema.extend({ handle: z.number().int().nonnegative(), start: z.number().int().nonnegative().default(0), count: z.number().int().positive().max(1000).default(100) }),
    readOnly: true,
  },
  {
    name: "debug_evaluate",
    title: "Evaluate in Python frame",
    description: "Evaluate an unrestricted Python expression in a paused frame.",
    inputSchema: AppIdSchema.extend({ frameId: z.string().min(1), expression: z.string().min(1) }),
    readOnly: false,
  },
  {
    name: "debug_set_variable",
    title: "Set Python debugger variable",
    description: "Set a local or global variable in a paused frame and synchronize fast locals.",
    inputSchema: AppIdSchema.extend({ frameId: z.string().min(1), scope: z.enum(["locals", "globals"]), name: z.string().min(1), value: z.unknown() }),
    readOnly: false,
  },
];

export function createMengineMcpServer(manager: SessionManager): McpServer {
  const server = new McpServer(
    { name: "mengine-mcp", version: MENGINE_MCP_VERSION },
    { instructions: "Launch an application before using runtime tools. Use hidden_render when screenshots are needed and headless_logic for logic-only checks. Builds are outside this MCP server." },
  );

  server.registerTool("app_list", {
    title: "List Mengine applications",
    description: "List descriptor applications, launch profiles, platforms, and active session state.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true },
  }, async () => successResult({ apps: manager.list() }));

  server.registerTool("app_install", {
    title: "Install Mengine application",
    description: "Run the explicit install command from a descriptor profile. This never builds the application.",
    inputSchema: z.object({ appId: z.string().min(1), profileId: z.string().min(1) }),
    annotations: { destructiveHint: true, idempotentHint: true },
  }, async ({ appId, profileId }) => invoke(() => manager.install(appId, profileId)));

  server.registerTool("app_launch", {
    title: "Launch Mengine application",
    description: "Launch an existing application artifact and wait for authenticated MCPPlugin connection.",
    inputSchema: z.object({ appId: z.string().min(1), profileId: z.string().min(1), mode: z.enum(["visible", "hidden_render", "headless_logic"]).default("visible") }),
    annotations: { destructiveHint: true, idempotentHint: false },
  }, async ({ appId, profileId, mode }) => invoke(() => manager.launch(appId, profileId, mode as LaunchMode)));

  server.registerTool("app_status", {
    title: "Read Mengine application status",
    description: "Return process, connection, requested/effective platform, launch mode, and runtime capabilities.",
    inputSchema: AppIdSchema,
    annotations: { readOnlyHint: true },
  }, async ({ appId }) => invoke(() => manager.status(appId)));

  server.registerTool("app_stop", {
    title: "Stop Mengine application",
    description: "Request orderly shutdown and optionally force-kill only the process owned by this MCP session.",
    inputSchema: AppIdSchema.extend({ force: z.boolean().default(false), gracefulTimeoutMs: z.number().int().positive().max(60_000).default(5_000) }),
    annotations: { destructiveHint: true, idempotentHint: true },
  }, async ({ appId, force, gracefulTimeoutMs }) => invoke(() => manager.stop(appId, force, gracefulTimeoutMs)));

  server.registerTool("frame_capture", {
    title: "Capture Mengine frame",
    description: "Capture a PNG from visible or hidden-render mode. Headless logic mode returns unsupported.",
    inputSchema: AppIdSchema.extend({ includeAlpha: z.boolean().default(false), timeoutMs: TimeoutSchema }),
    annotations: { readOnlyHint: true },
  }, async ({ appId, includeAlpha, timeoutMs }) => {
    try {
      const value = await manager.request(appId, "frame_capture", { includeAlpha }, timeoutMs) as { response?: unknown; binary?: Buffer };
      if (value?.binary === undefined) {
        return successResult(value);
      }
      return {
        content: [
          { type: "image" as const, data: value.binary.toString("base64"), mimeType: "image/png" },
          { type: "text" as const, text: JSON.stringify(value.response ?? {}) },
        ],
      };
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool("logs_read", {
    title: "Read Mengine logs",
    description: "Read runtime logger records, adapter-captured process output, or both.",
    inputSchema: AppIdSchema.extend({ source: z.enum(["runtime", "process", "both"]).default("both"), after: z.number().int().nonnegative().default(0), limit: z.number().int().positive().max(5000).default(500) }),
    annotations: { readOnlyHint: true },
  }, async ({ appId, source, after, limit }) => {
    try {
      const processLogs = source === "runtime" ? undefined : manager.readCapturedLogs(appId, after);
      const runtimeLogs = source === "process" ? undefined : await manager.request(appId, "logs_read", { after, limit });
      return successResult({ runtime: runtimeLogs, process: processLogs });
    } catch (error) {
      if (source === "both" || source === "process") {
        try {
          return successResult({ runtimeError: error instanceof Error ? error.message : String(error), process: manager.readCapturedLogs(appId, after) });
        } catch {
          // Return the original runtime/session error below.
        }
      }
      return errorResult(error);
    }
  });

  server.registerTool("script_reload_module", {
    title: "Reload Python module explicitly",
    description: "Read a source file from configured script roots, transfer it to the running app, and transactionally reload the live module.",
    inputSchema: AppIdSchema.extend({ module: z.string().min(1), sourcePath: z.string().min(1), timeoutMs: TimeoutSchema }),
    annotations: { destructiveHint: true, idempotentHint: false },
  }, async ({ appId, module, sourcePath, timeoutMs }) => {
    try {
      const file = await manager.readScriptFile(appId, sourcePath);
      const value = await manager.request(appId, "script_reload_module", {
        module,
        logicalPath: file.logicalPath,
        modulePath: file.modulePath,
        encoding: "utf-8",
      }, timeoutMs, file.source);
      return successResult(value);
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool("resource_reload", {
    title: "Reload Mengine resources explicitly",
    description: "Transfer files from configured asset roots, apply a session overlay, and rebuild affected resources as a batch.",
    inputSchema: AppIdSchema.extend({ sourcePaths: z.array(z.string().min(1)).min(1).max(128), timeoutMs: TimeoutSchema }),
    annotations: { destructiveHint: true, idempotentHint: false },
  }, async ({ appId, sourcePaths, timeoutMs }) => {
    try {
      const files = await Promise.all(sourcePaths.map(sourcePath => manager.readAssetFile(appId, sourcePath)));
      let offset = 0;
      const entries = files.map(file => {
        const entry = { fileGroup: file.fileGroup, logicalPath: file.logicalPath, offset, size: file.source.length };
        offset += file.source.length;
        return entry;
      });
      const attachment = Buffer.concat(files.map(file => file.source));
      const value = await manager.request(appId, "resource_reload", { entries }, timeoutMs, attachment);
      return successResult(value);
    } catch (error) {
      return errorResult(error);
    }
  });

  for (const definition of runtimeTools) {
    server.registerTool(definition.name, {
      title: definition.title,
      description: definition.description,
      inputSchema: definition.inputSchema,
      annotations: definition.readOnly
        ? { readOnlyHint: true }
        : { destructiveHint: true, idempotentHint: false },
    }, async input => {
      const { appId, timeoutMs, ...params } = input as { appId: string; timeoutMs?: number; [key: string]: unknown };
      return invoke(() => manager.request(appId, definition.name, params, timeoutMs));
    });
  }

  return server;
}

async function invoke(callback: () => unknown | Promise<unknown>): Promise<ReturnType<typeof successResult> | ReturnType<typeof errorResult>> {
  try {
    return successResult(await callback());
  } catch (error) {
    return errorResult(error);
  }
}
