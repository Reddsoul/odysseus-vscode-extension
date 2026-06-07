import * as vscode from "vscode";
import * as path from "path";

const MAX_CHARS = 20000;

export interface FileContext {
  filePath: string;
  language: string;
  content: string;
  truncated: boolean;
}

export interface SelectionContext {
  text: string;
  startLine: number;
  endLine: number;
  language: string;
}

export function getActiveFileContext(): FileContext | null {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return null;
  }
  const doc = editor.document;
  const full = doc.getText();
  const truncated = full.length > MAX_CHARS;
  return {
    filePath: doc.fileName,
    language: doc.languageId,
    content: truncated ? full.slice(0, MAX_CHARS) : full,
    truncated,
  };
}

export function getSelectionContext(): SelectionContext | null {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    return null;
  }
  const doc = editor.document;
  const sel = editor.selection;
  return {
    text: doc.getText(sel),
    startLine: sel.start.line + 1,
    endLine: sel.end.line + 1,
    language: doc.languageId,
  };
}

export function getWorkspaceRoot(): string | null {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
}

export function buildDisplayMessage(
  userMessage: string,
  selection: SelectionContext | null
): string {
  if (!selection) { return userMessage; }
  const lineRange =
    selection.startLine === selection.endLine
      ? `line ${selection.startLine}`
      : `lines ${selection.startLine}–${selection.endLine}`;
  return (
    userMessage +
    `\n\nSelected (${lineRange}):\n\`\`\`${selection.language}\n${selection.text}\n\`\`\``
  );
}

/** Builds the message sent to the API — includes workspace context the model needs but the user doesn't need to see. */
export function buildApiMessage(
  displayMessage: string,
  workspaceRoot: string | null,
  fileCtx: FileContext | null
): string {
  const lines: string[] = [];
  if (workspaceRoot) {
    lines.push(`<vscode_workspace>`);
    lines.push(`working_directory: ${workspaceRoot}`);
    if (fileCtx) {
      lines.push(`active_file: ${fileCtx.filePath}`);
      lines.push(`language: ${fileCtx.language}`);
    }
    // List top-level files so the model can navigate the project
    try {
      const { readdirSync, statSync } = require("fs") as typeof import("fs");
      const entries = readdirSync(workspaceRoot)
        .filter((f: string) => !f.startsWith(".") && f !== "node_modules" && f !== "__pycache__")
        .slice(0, 40);
      lines.push(`files: ${entries.join(", ")}`);
    } catch { /* ignore */ }
    lines.push(`</vscode_workspace>`);
    lines.push(`<instructions>`);
    lines.push(`You are an AI coding assistant running inside VS Code, connected to a local Odysseus instance.`);
    lines.push(`The working_directory above is a REAL path on the local filesystem of this machine.`);
    lines.push(`IMPORTANT — when the user asks you to create, edit, or modify a file:`);
    lines.push(`  1. Use the write_file tool with the FULL absolute path (e.g. ${workspaceRoot}/README.md).`);
    lines.push(`  2. Never output file contents as chat text when asked to edit — write to disk directly.`);
    lines.push(`  3. To read a file, use read_file with its full path.`);
    lines.push(`  4. After writing, confirm what changed in one sentence.`);
    lines.push(`</instructions>`);
    lines.push("");
  }
  lines.push(displayMessage);
  return lines.join("\n");
}

/** @deprecated use buildDisplayMessage */
export function buildMessageWithContext(
  userMessage: string,
  selection: SelectionContext | null
): string {
  return buildDisplayMessage(userMessage, selection);
}

export function fileTitle(filePath: string): string {
  return path.basename(filePath);
}
