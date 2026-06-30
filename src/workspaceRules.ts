import * as vscode from "vscode";

let _cachedRules: string | null | undefined = undefined; // undefined = not yet loaded
let _watcher: vscode.FileSystemWatcher | undefined;

export function initRulesWatcher(context: vscode.ExtensionContext): void {
  _watcher?.dispose();
  _watcher = vscode.workspace.createFileSystemWatcher("**/.odysseusrules");
  const invalidate = () => { _cachedRules = undefined; };
  _watcher.onDidChange(invalidate, undefined, context.subscriptions);
  _watcher.onDidCreate(invalidate, undefined, context.subscriptions);
  _watcher.onDidDelete(() => { _cachedRules = null; }, undefined, context.subscriptions);
  context.subscriptions.push(_watcher);
}

export async function getWorkspaceRulesContent(): Promise<string | null> {
  if (_cachedRules !== undefined) { return _cachedRules; }
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) { _cachedRules = null; return null; }
  try {
    const rulesUri = vscode.Uri.joinPath(root, ".odysseusrules");
    const bytes = await vscode.workspace.fs.readFile(rulesUri);
    _cachedRules = Buffer.from(bytes).toString("utf-8");
    return _cachedRules;
  } catch {
    _cachedRules = null;
    return null;
  }
}

export async function createOdysseusRulesFile(): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) {
    vscode.window.showWarningMessage("No workspace folder open.");
    return;
  }
  const rulesUri = vscode.Uri.joinPath(root, ".odysseusrules");
  try {
    await vscode.workspace.fs.stat(rulesUri);
    vscode.window.showInformationMessage(".odysseusrules already exists — opening it.");
  } catch {
    const template = [
      "# Odysseus Workspace Rules",
      "# These instructions are injected into every conversation in this workspace.",
      "",
      "## Coding conventions",
      "- ",
      "",
      "## Architecture notes",
      "- ",
      "",
      "## Do not modify",
      "- ",
      "",
    ].join("\n");
    await vscode.workspace.fs.writeFile(rulesUri, Buffer.from(template, "utf-8"));
  }
  _cachedRules = undefined; // invalidate cache
  await vscode.window.showTextDocument(rulesUri);
}
