const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const Module = require("node:module");
const path = require("node:path");

const repositoryRoot = path.resolve(__dirname, "..");
const serverPath = path.join(repositoryRoot, "dist", "mengine-mcp.mjs");
const extensionPath = path.join(repositoryRoot, "dist", "extension.cjs");
const serverLines = readFileSync(serverPath, "utf8").split(/\r?\n/u);

assert.equal(serverLines.filter(line => line.startsWith("#!")).length, 1);

const serverResult = spawnSync(process.execPath, [
  serverPath,
  "--config",
  path.join(repositoryRoot, "definitely-missing", ".mengine", "mcp.json"),
], {
  encoding: "utf8",
});

assert.equal(serverResult.status, 1);
assert.match(serverResult.stderr, /^mengine-mcp:/u);

const registeredProviders = [];
const registeredCommands = [];
const disposable = { dispose() {} };
const output = { appendLine() {}, dispose() {}, show() {} };

class MockEventEmitter {
  event() {}
  fire() {}
  dispose() {}
}

const vscode = {
  EventEmitter: MockEventEmitter,
  Disposable: {
    from() {
      return disposable;
    },
  },
  commands: {
    executeCommand() {},
    registerCommand(command) {
      registeredCommands.push(command);
      return disposable;
    },
  },
  extensions: {
    getExtension() {
      return undefined;
    },
  },
  lm: {
    registerMcpServerDefinitionProvider(id, provider) {
      registeredProviders.push({ id, provider });
      return disposable;
    },
  },
  workspace: {
    isTrusted: true,
    workspaceFolders: [],
    getConfiguration() {
      return { get() { return undefined; } };
    },
    onDidGrantWorkspaceTrust() {
      return disposable;
    },
    onDidChangeWorkspaceFolders() {
      return disposable;
    },
  },
  window: {
    createOutputChannel() {
      return output;
    },
    async showErrorMessage() {},
    async showInformationMessage() {},
    async showWarningMessage() {},
  },
};

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === "vscode") {
    return vscode;
  }

  return originalLoad.call(this, request, parent, isMain);
};

try {
  const extension = require(extensionPath);
  const subscriptions = [];
  extension.activate({
    asAbsolutePath(relativePath) {
      return path.join(repositoryRoot, relativePath);
    },
    extension: {
      packageJSON: {
        version: "0.3.2",
      },
    },
    extensionUri: {},
    globalState: {
      get() {
        return undefined;
      },
      async update() {},
    },
    subscriptions,
  });

  assert.deepEqual(registeredProviders.map(entry => entry.id), ["mengine.mcp"]);
  assert.deepEqual(registeredCommands, [
    "mengineMcp.createConfiguration",
    "mengineMcp.openConfiguration",
    "mengineMcp.connectCodex",
    "mengineMcp.disconnectCodex",
    "mengineMcp.showCodexStatus",
  ]);
  assert.equal(typeof registeredProviders[0].provider.provideMcpServerDefinitions, "function");
} finally {
  Module._load = originalLoad;
}

console.log("Mengine MCP bundles passed smoke validation.");
