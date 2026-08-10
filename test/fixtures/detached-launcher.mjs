import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const options = new Map();

for (let index = 0; index !== args.length; ++index) {
  const value = args[index];

  if (value.startsWith("--mcp-") && value.includes(":")) {
    const separator = value.indexOf(":");
    options.set(value.slice(2, separator), value.slice(separator + 1));
    continue;
  }

  if (value === "--es" && args[index + 1]?.startsWith("mengine.mcp.") === true) {
    options.set(`mcp-${args[index + 1].slice("mengine.mcp.".length)}`, args[index + 2] ?? "");
    index += 2;
  }
}

const runtimePath = fileURLToPath(new URL("./detached-runtime.mjs", import.meta.url));
const runtime = spawn(process.execPath, [
  runtimePath,
  options.get("mcp-host") ?? "127.0.0.1",
  options.get("mcp-port") ?? "0",
  options.get("mcp-token") ?? "",
], {
  detached: true,
  stdio: "ignore",
});
runtime.unref();
