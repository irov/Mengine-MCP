import { readFile, rm } from "node:fs/promises";
import { build } from "esbuild";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const versionDefine = {
  __MENGINE_MCP_VERSION__: JSON.stringify(packageJson.version),
};

await rm(new URL("../dist", import.meta.url), { force: true, recursive: true });

await Promise.all([
  build({
    entryPoints: ["src/extension.ts"],
    outfile: "dist/extension.cjs",
    bundle: true,
    external: ["vscode"],
    format: "cjs",
    platform: "node",
    target: "node20",
    sourcemap: false,
    define: versionDefine,
    logLevel: "info",
  }),
  build({
    entryPoints: ["src/index.ts"],
    outfile: "dist/mengine-mcp.mjs",
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    sourcemap: false,
    define: versionDefine,
    logLevel: "info",
  }),
]);
