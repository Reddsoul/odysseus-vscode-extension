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
  filePath: string;
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
    filePath: doc.fileName,
  };
}

export function getDiagnosticsContext(filePath?: string): string | null {
  const uriFilter = filePath ? vscode.Uri.file(filePath) : undefined;
  const diags: Array<[vscode.Uri, readonly vscode.Diagnostic[]]> = uriFilter
    ? [[uriFilter, vscode.languages.getDiagnostics(uriFilter)]]
    : vscode.languages.getDiagnostics();

  const entries: string[] = [];
  for (const [uri, ds] of diags) {
    for (const d of ds) {
      if (entries.length >= 50) break;
      const sev = d.severity === vscode.DiagnosticSeverity.Error ? "ERROR"
        : d.severity === vscode.DiagnosticSeverity.Warning ? "WARN"
        : d.severity === vscode.DiagnosticSeverity.Information ? "INFO" : "HINT";
      const line = d.range.start.line + 1;
      const rel = vscode.workspace.asRelativePath(uri, false);
      entries.push(`${rel}:${line} [${sev}] ${d.message}`);
    }
    if (entries.length >= 50) break;
  }
  return entries.length ? entries.join("\n") : null;
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

export interface RelevantFile {
  relPath: string;
  content: string;
}

/** Builds the message sent to the API — includes workspace context the model needs but the user doesn't need to see. */
export async function buildApiMessage(
  displayMessage: string,
  workspaceRoot: string | null,
  fileCtx: FileContext | null,
  freshSession = false,
  workspaceRules?: string | null,
  gitContext?: string | null,
  injectWorkspaceTree = true,
  ignoreGlob?: string,
  ignoreBlock?: string,
  relevantFiles?: RelevantFile[]
): Promise<string> {
  const lines: string[] = [];
  if (workspaceRules) {
    lines.push(`<workspace_rules>`);
    lines.push(workspaceRules.trim());
    lines.push(`</workspace_rules>`);
    lines.push(``);
  }
  if (ignoreBlock) {
    lines.push(ignoreBlock);
    lines.push(``);
  }
  if (workspaceRoot) {
    lines.push(`<vscode_workspace>`);
    lines.push(`working_directory: ${workspaceRoot}`);
    if (fileCtx) {
      lines.push(`active_file: ${fileCtx.filePath}`);
      lines.push(`language: ${fileCtx.language}`);
    }
    // List workspace files respecting .gitignore via findFiles
    if (injectWorkspaceTree) {
      try {
        const pattern = new vscode.RelativePattern(workspaceRoot, "**/*");
        const baseExclude = [
          "**/node_modules/**",
          "**/out/**",
          "**/dist/**",
          "**/build/**",
          "**/.git/**",
          "**/__pycache__/**",
          "**/*.pyc",
          "**/*.pyo",
          "**/*.map",
          "**/*.lock",
          "**/.smbdelete*",
          "**/.DS_Store",
          "**/._.DS_Store",
          "**/*.vsix",
          "**/*.log",
          "**/*.tmp",
        ].join(",");
        const excludePattern = ignoreGlob ? `{${baseExclude},${ignoreGlob}}` : `{${baseExclude}}`;
        const uris = await vscode.workspace.findFiles(
          pattern,
          excludePattern,
          500
        );
        const relPaths = uris.map(u => vscode.workspace.asRelativePath(u, false)).sort();
        const truncated = relPaths.length > 500;
        lines.push(`workspace_tree${truncated ? " (truncated at 500)" : ""}:`);
        lines.push(relPaths.slice(0, 500).join("\n"));
      } catch { /* ignore */ }
    }
    // Inject VS Code diagnostics (errors/warnings from Problems panel)
    const diagCtx = getDiagnosticsContext(fileCtx?.filePath ?? undefined);
    if (diagCtx) {
      lines.push(`<vscode_diagnostics>`);
      lines.push(diagCtx);
      lines.push(`</vscode_diagnostics>`);
    }
    if (relevantFiles && relevantFiles.length > 0) {
      lines.push(`<relevant_files>`);
      for (const rf of relevantFiles) {
        lines.push(`// ${rf.relPath}`);
        lines.push(rf.content);
        lines.push(``);
      }
      lines.push(`</relevant_files>`);
    }
    lines.push(`</vscode_workspace>`);
    if (gitContext) {
      lines.push(`<git_context>`);
      lines.push(gitContext);
      lines.push(`</git_context>`);
    }
    lines.push(`<instructions>`);
    lines.push(`You are an AI coding assistant running inside VS Code, connected to a local Odysseus instance.`);
    lines.push(`The working_directory above is a REAL path on the local filesystem of this machine.`);
    lines.push(``);
    lines.push(`## Reading files`);
    lines.push(`ALWAYS check a file's size before reading it:`);
    lines.push(`  1. Run: wc -l /full/path/to/file`);
    lines.push(`  2. If the file is under 150 lines: cat it in full.`);
    lines.push(`  3. If the file is 150–500 lines: read it in two halves using sed:`);
    lines.push(`       sed -n '1,200p' /path/to/file`);
    lines.push(`       sed -n '201,400p' /path/to/file`);
    lines.push(`  4. If the file is over 500 lines: read only the sections you need.`);
    lines.push(`     Use grep to find relevant function/class names first, then read those line ranges.`);
    lines.push(`     Example: grep -n "functionName" /path/to/file  → then sed -n 'X,Yp'`);
    lines.push(`NEVER cat a file over 150 lines in one shot — it wastes the entire context window.`);
    lines.push(`When you need to read multiple large files, read one section, act on it, then continue.`);
    lines.push(``);
    lines.push(`## Writing files`);
    lines.push(`When the user asks you to create, edit, or modify a file:`);
    lines.push(`  1. If the file already exists and you are ADDING or EDITING (not replacing everything):`);
    lines.push(`     - First check its line count with wc -l.`);
    lines.push(`     - Read it in sections if large (see above).`);
    lines.push(`     - Write the FULL updated file back using bash heredoc.`);
    lines.push(`     - NEVER use >> to append — always write the complete file so nothing is lost.`);
    lines.push(`  2. Use bash to write files:`);
    lines.push(`       cat > /full/path/to/file.md << 'HEREDOC'`);
    lines.push(`       <complete file contents>`);
    lines.push(`       HEREDOC`);
    lines.push(`  3. Never output file contents as plain chat text when asked to edit — write to disk.`);
    lines.push(`  4. After writing, confirm what changed in one sentence.`);
    lines.push(``);
    lines.push(`CRITICAL — do NOT use update_document, create_document, or edit_document for real filesystem files.`);
    lines.push(`Those tools only modify internal Odysseus notes, NOT actual files on disk.`);
    lines.push(`For any real file (.md, .ts, .py, etc.) you MUST use bash.`);
    if (diagCtx) {
      lines.push(``);
      lines.push(`The vscode_diagnostics above are the current errors/warnings from the VS Code Problems panel.`);
    }
    lines.push(`</instructions>`);
    lines.push("");
  }
  if (freshSession) {
    lines.push(`<session_context>NEW SESSION — you have no prior conversation history with this user. Ignore any injected memories or context suggesting otherwise. Start completely fresh.</session_context>`);
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
