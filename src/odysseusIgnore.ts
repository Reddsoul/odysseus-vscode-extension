import * as vscode from "vscode";

const HARDCODED_DEFAULTS: string[] = [
  ".smbdelete*",
  ".DS_Store",
  "._.DS_Store",
  "__MACOSX",
  "*.vsix",
  "*.log",
  "*.tmp",
];

let _cached: string[] | null | undefined = undefined;
let _watcher: vscode.FileSystemWatcher | undefined;

export function initIgnoreWatcher(context: vscode.ExtensionContext): void {
  _watcher?.dispose();
  _watcher = vscode.workspace.createFileSystemWatcher("**/.odysseusignore");
  const invalidate = () => { _cached = undefined; };
  _watcher.onDidChange(invalidate, undefined, context.subscriptions);
  _watcher.onDidCreate(invalidate, undefined, context.subscriptions);
  _watcher.onDidDelete(() => { _cached = null; }, undefined, context.subscriptions);
  context.subscriptions.push(_watcher);
}

export async function getIgnorePatterns(): Promise<string[] | null> {
  if (_cached !== undefined) { return _cached; }
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) { _cached = HARDCODED_DEFAULTS; return HARDCODED_DEFAULTS; }
  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, ".odysseusignore"));
    const userLines = Buffer.from(bytes).toString("utf-8")
      .split("\n")
      .map(l => l.trim())
      .filter(l => l && !l.startsWith("#"));
    _cached = [...HARDCODED_DEFAULTS, ...userLines];
    return _cached;
  } catch {
    _cached = HARDCODED_DEFAULTS;
    return HARDCODED_DEFAULTS;
  }
}

/** Convert .odysseusignore lines → VS Code glob exclude string (comma-separated). */
export function patternsToGlob(patterns: string[]): string {
  return patterns.flatMap(p => {
    if (p.endsWith("/")) { return [`**/${p.slice(0, -1)}/**`]; }
    if (p.includes("/"))  { return [p.startsWith("/") ? p.slice(1) : `**/${p}`]; }
    if (p.startsWith("*.")) { return [`**/${p}`]; }
    return [`**/${p}/**`, `**/${p}`];
  }).join(",");
}

/** Build the <file_restrictions> block injected into the system context. */
export function buildIgnoreBlock(patterns: string[]): string {
  return [
    `<file_restrictions>`,
    `Do NOT read, write, or reference these paths/patterns:`,
    ...patterns.map(p => `  - ${p}`),
    `</file_restrictions>`,
  ].join("\n");
}
