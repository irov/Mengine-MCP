import * as path from "node:path";

import * as vscode from "vscode";

import {
  MengineCodexRegistrationManager,
  UnmanagedCodexMcpRegistrationError,
  formatError,
} from "./codexRegistration.js";
import {
  CONNECT_CODEX_COMMAND,
  CREATE_CONFIGURATION_COMMAND,
  DESCRIPTOR_FILE_NAME,
  DISCONNECT_CODEX_COMMAND,
  MCP_PROVIDER_ID,
  OPEN_CONFIGURATION_COMMAND,
  SHOW_CODEX_STATUS_COMMAND,
  makeServerLabel,
  makeServerVersion,
} from "./extensionSupport.js";

class MengineMcpServerProvider implements vscode.McpServerDefinitionProvider<vscode.McpStdioServerDefinition>, vscode.Disposable {
  private readonly didChangeEmitter = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly watchers: vscode.FileSystemWatcher[] = [];

  public readonly onDidChangeMcpServerDefinitions = this.didChangeEmitter.event;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly onDescriptorChange: () => void,
  ) {
    this.rebuildWatchers();
    this.disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
      this.rebuildWatchers();
      this.refresh();
      this.onDescriptorChange();
    }));
  }

  public async provideMcpServerDefinitions(token: vscode.CancellationToken): Promise<vscode.McpStdioServerDefinition[]> {
    const definitions: vscode.McpStdioServerDefinition[] = [];
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];

    for (const workspaceFolder of workspaceFolders) {
      if (token.isCancellationRequested === true) {
        break;
      }

      const descriptorUri = vscode.Uri.joinPath(workspaceFolder.uri, DESCRIPTOR_FILE_NAME);
      const descriptorStat = await statFile(descriptorUri);

      if (descriptorStat === undefined) {
        continue;
      }

      const serverPath = this.context.asAbsolutePath(path.join("dist", "mengine-mcp.mjs"));
      const extensionVersion = String(this.context.extension.packageJSON.version);
      const definition = new vscode.McpStdioServerDefinition(
        makeServerLabel(workspaceFolder.name),
        process.execPath,
        [serverPath, "--config", descriptorUri.fsPath],
        {},
        makeServerVersion(extensionVersion, descriptorStat.mtime),
      );
      definition.cwd = workspaceFolder.uri;
      definitions.push(definition);
    }

    return definitions;
  }

  public async resolveMcpServerDefinition(
    server: vscode.McpStdioServerDefinition,
    _token: vscode.CancellationToken,
  ): Promise<vscode.McpStdioServerDefinition> {
    const serverPath = this.context.asAbsolutePath(path.join("dist", "mengine-mcp.mjs"));
    const serverUri = vscode.Uri.file(serverPath);
    const serverStat = await statFile(serverUri);

    if (serverStat === undefined) {
      throw new Error(`Mengine MCP server bundle is missing: ${serverPath}`);
    }

    return server;
  }

  public refresh(): void {
    this.didChangeEmitter.fire();
  }

  public dispose(): void {
    this.disposeWatchers();
    vscode.Disposable.from(...this.disposables).dispose();
    this.didChangeEmitter.dispose();
  }

  private rebuildWatchers(): void {
    this.disposeWatchers();

    for (const workspaceFolder of vscode.workspace.workspaceFolders ?? []) {
      const pattern = new vscode.RelativePattern(workspaceFolder, DESCRIPTOR_FILE_NAME);
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      const refresh = (): void => {
        this.refresh();
        this.onDescriptorChange();
      };
      watcher.onDidCreate(refresh);
      watcher.onDidChange(refresh);
      watcher.onDidDelete(refresh);
      this.watchers.push(watcher);
    }
  }

  private disposeWatchers(): void {
    for (const watcher of this.watchers) {
      watcher.dispose();
    }

    this.watchers.length = 0;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Mengine MCP");
  const registration = new MengineCodexRegistrationManager(context, output);
  const reconcile = (): void => {
    void reconcileCodexRegistration(context, registration, output);
  };
  const provider = new MengineMcpServerProvider(context, reconcile);

  context.subscriptions.push(
    output,
    provider,
    vscode.lm.registerMcpServerDefinitionProvider(MCP_PROVIDER_ID, provider),
    vscode.commands.registerCommand(CREATE_CONFIGURATION_COMMAND, async () => {
      const created = await createConfiguration(context);

      if (created === true) {
        provider.refresh();
      }
    }),
    vscode.commands.registerCommand(OPEN_CONFIGURATION_COMMAND, async () => {
      await openWorkspaceConfiguration();
    }),
    vscode.commands.registerCommand(CONNECT_CODEX_COMMAND, async () => {
      await connectCodexInteractively(registration);
    }),
    vscode.commands.registerCommand(DISCONNECT_CODEX_COMMAND, async () => {
      if (!vscode.workspace.isTrusted) {
        void vscode.window.showErrorMessage("Trust this workspace before changing the Mengine MCP Codex registration.");
        return;
      }
      try {
        const disconnected = await registration.disconnect();
        void vscode.window.showInformationMessage(disconnected
          ? "Mengine MCP was disconnected from Codex. Restart Codex to remove its tools from active sessions."
          : "Mengine MCP is not registered in Codex.");
      } catch (error) {
        void vscode.window.showErrorMessage(`Could not disconnect Mengine MCP from Codex: ${formatError(error)}`);
      }
    }),
    vscode.commands.registerCommand(SHOW_CODEX_STATUS_COMMAND, async () => {
      if (!vscode.workspace.isTrusted) {
        void vscode.window.showErrorMessage("Trust this workspace before reading the Mengine MCP Codex registration.");
        return;
      }
      await showCodexStatus(registration, output);
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(reconcile),
  );

  reconcile();
}

async function reconcileCodexRegistration(
  context: vscode.ExtensionContext,
  registration: MengineCodexRegistrationManager,
  output: vscode.OutputChannel,
): Promise<void> {
  if (!vscode.workspace.isTrusted || !await hasConfiguredWorkspace()) {
    return;
  }

  try {
    const changed = await registration.reconcile();
    if (changed) {
      const noticeKey = "mengineMcp.codexConnectedNoticeShown";
      if (!context.globalState.get<boolean>(noticeKey)) {
        await context.globalState.update(noticeKey, true);
        void vscode.window.showInformationMessage(
          "Mengine MCP was connected to Codex. Start a new agent or restart the Codex extension to use its tools.",
        );
      }
    }
  } catch (error) {
    const version = String(context.extension.packageJSON.version);
    const reason = error instanceof UnmanagedCodexMcpRegistrationError ? "unmanaged" : "unavailable";
    const noticeKey = `mengineMcp.codexNotice.${version}.${reason}`;
    if (context.globalState.get<boolean>(noticeKey)) {
      return;
    }

    await context.globalState.update(noticeKey, true);
    output.appendLine(`Mengine MCP Codex registration needs attention: ${formatError(error)}`);
    const action = await vscode.window.showWarningMessage(
      `Mengine MCP could not connect to Codex automatically: ${formatError(error)}`,
      "Connect Codex",
      "Show Status",
    );
    if (action === "Connect Codex") {
      await vscode.commands.executeCommand(CONNECT_CODEX_COMMAND);
    } else if (action === "Show Status") {
      await vscode.commands.executeCommand(SHOW_CODEX_STATUS_COMMAND);
    }
  }
}

async function connectCodexInteractively(registration: MengineCodexRegistrationManager): Promise<void> {
  if (!vscode.workspace.isTrusted) {
    void vscode.window.showErrorMessage("Trust this workspace before connecting Mengine MCP to Codex.");
    return;
  }
  if (!await hasConfiguredWorkspace()) {
    void vscode.window.showErrorMessage(`Open a workspace containing ${DESCRIPTOR_FILE_NAME} before connecting Codex.`);
    return;
  }

  try {
    let result;
    try {
      result = await registration.connect();
    } catch (error) {
      if (!(error instanceof UnmanagedCodexMcpRegistrationError)) {
        throw error;
      }

      const choice = await vscode.window.showWarningMessage(
        `A Codex MCP server named 'mengine' already exists and is not managed by this extension. Replace it?`,
        { modal: true },
        "Replace",
      );
      if (choice !== "Replace") {
        return;
      }
      result = await registration.connect({ replaceUnmanaged: true });
    }

    void vscode.window.showInformationMessage(result.changed
      ? "Mengine MCP was connected to Codex. Start a new agent or restart the Codex extension."
      : "Mengine MCP is already connected to Codex.");
  } catch (error) {
    void vscode.window.showErrorMessage(`Could not connect Mengine MCP to Codex: ${formatError(error)}`);
  }
}

async function showCodexStatus(
  registration: MengineCodexRegistrationManager,
  output: vscode.OutputChannel,
): Promise<void> {
  try {
    const status = await registration.getStatus();
    output.appendLine(JSON.stringify(status, null, 2));
    const show = status.managed && status.upToDate
      ? vscode.window.showInformationMessage
      : vscode.window.showWarningMessage;
    const action = await show(status.message, "Show Output");
    if (action === "Show Output") {
      output.show(true);
    }
  } catch (error) {
    output.appendLine(`Could not read Codex MCP status: ${formatError(error)}`);
    output.show(true);
    void vscode.window.showErrorMessage(`Could not read Mengine MCP Codex status: ${formatError(error)}`);
  }
}

async function hasConfiguredWorkspace(): Promise<boolean> {
  for (const workspaceFolder of vscode.workspace.workspaceFolders ?? []) {
    const descriptorUri = vscode.Uri.joinPath(workspaceFolder.uri, DESCRIPTOR_FILE_NAME);
    if (await statFile(descriptorUri) !== undefined) {
      return true;
    }
  }

  return false;
}

async function createConfiguration(context: vscode.ExtensionContext): Promise<boolean> {
  const workspaceFolder = await selectWorkspaceFolder();

  if (workspaceFolder === undefined) {
    return false;
  }

  const descriptorUri = vscode.Uri.joinPath(workspaceFolder.uri, DESCRIPTOR_FILE_NAME);
  const descriptorStat = await statFile(descriptorUri);

  if (descriptorStat !== undefined) {
    await openConfiguration(descriptorUri);
    void vscode.window.showInformationMessage(`${DESCRIPTOR_FILE_NAME} already exists in ${workspaceFolder.name}.`);

    return false;
  }

  const templateUri = vscode.Uri.joinPath(context.extensionUri, "mengine.mcp.example.json");
  const template = await vscode.workspace.fs.readFile(templateUri);
  await vscode.workspace.fs.writeFile(descriptorUri, template);
  await openConfiguration(descriptorUri);
  void vscode.window.showInformationMessage(`Created ${DESCRIPTOR_FILE_NAME} in ${workspaceFolder.name}.`);

  return true;
}

async function selectWorkspaceFolder(): Promise<vscode.WorkspaceFolder | undefined> {
  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];

  if (workspaceFolders.length === 0) {
    void vscode.window.showErrorMessage("Open a Mengine game folder before creating an MCP configuration.");

    return undefined;
  }

  if (workspaceFolders.length === 1) {
    return workspaceFolders[0];
  }

  const selected = await vscode.window.showWorkspaceFolderPick({
    placeHolder: "Select the Mengine game workspace",
  });

  return selected;
}

async function openWorkspaceConfiguration(): Promise<void> {
  const configurations: Array<{ workspaceFolder: vscode.WorkspaceFolder; uri: vscode.Uri }> = [];

  for (const workspaceFolder of vscode.workspace.workspaceFolders ?? []) {
    const uri = vscode.Uri.joinPath(workspaceFolder.uri, DESCRIPTOR_FILE_NAME);
    const descriptorStat = await statFile(uri);

    if (descriptorStat !== undefined) {
      configurations.push({ workspaceFolder, uri });
    }
  }

  if (configurations.length === 0) {
    const action = await vscode.window.showInformationMessage(
      `No ${DESCRIPTOR_FILE_NAME} was found at a workspace root.`,
      "Create Configuration",
    );

    if (action === "Create Configuration") {
      await vscode.commands.executeCommand(CREATE_CONFIGURATION_COMMAND);
    }

    return;
  }

  let selected = configurations[0];

  if (configurations.length > 1) {
    const picked = await vscode.window.showQuickPick(
      configurations.map(configuration => ({
        label: configuration.workspaceFolder.name,
        description: configuration.uri.fsPath,
        configuration,
      })),
      { placeHolder: "Select a Mengine MCP configuration" },
    );
    selected = picked?.configuration;
  }

  if (selected !== undefined) {
    await openConfiguration(selected.uri);
  }
}

async function statFile(uri: vscode.Uri): Promise<vscode.FileStat | undefined> {
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    const isFile = (stat.type & vscode.FileType.File) !== 0;

    return isFile === true ? stat : undefined;
  } catch (error) {
    if (error instanceof vscode.FileSystemError && error.code === "FileNotFound") {
      return undefined;
    }

    throw error;
  }
}

async function openConfiguration(uri: vscode.Uri): Promise<void> {
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document);
}
