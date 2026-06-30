import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

interface IndexedFile {
  relPath: string;
  language: string;
  symbols: string[];
  lineCount: number;
  lastModified: number;
}

interface WorkspaceIndex {
  version: number;
  workspaceRoot: string;
  builtAt: number;
  files: Record<string, IndexedFile>;
}

const INDEX_VERSION = 1;
const INDEX_TTL_MS = 30 * 60 * 1000; // 30 min
const MAX_FILE_BYTES = 50 * 1024;     // 50 KB — skip large files

const BASE_EXCLUDE = [
  "**/node_modules/**", "**/out/**", "**/dist/**", "**/build/**",
  "**/.git/**", "**/__pycache__/**", "**/*.pyc", "**/*.pyo",
  "**/*.map", "**/*.lock", "**/.smbdelete*", "**/.DS_Store",
  "**/._.DS_Store", "**/*.vsix", "**/*.log", "**/*.tmp",
  "**/*.jpg", "**/*.jpeg", "**/*.png", "**/*.gif", "**/*.svg",
  "**/*.ico", "**/*.woff", "**/*.woff2", "**/*.ttf", "**/*.eot",
  "**/*.min.js", "**/*.min.css",
].join(",");

export class WorkspaceIndexManager {
  private index: WorkspaceIndex | null = null;
  private indexPath: string | null = null;
  private building = false;
  private watcher: vscode.FileSystemWatcher | null = null;

  constructor(private readonly context: vscode.ExtensionContext) {}

  private getIndexPath(workspaceRoot: string): string {
    const hash = crypto.createHash("sha1").update(workspaceRoot).digest("hex").slice(0, 8);
    const dir = path.join(this.context.globalStorageUri.fsPath, "workspace-index");
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, `${hash}.json`);
  }

  private loadFromDisk(indexPath: string): WorkspaceIndex | null {
    try {
      const raw = fs.readFileSync(indexPath, "utf-8");
      const parsed = JSON.parse(raw) as WorkspaceIndex;
      if (parsed.version !== INDEX_VERSION) { return null; }
      return parsed;
    } catch {
      return null;
    }
  }

  private saveToDisk(indexPath: string, index: WorkspaceIndex): void {
    try {
      fs.writeFileSync(indexPath, JSON.stringify(index), "utf-8");
    } catch { /* ignore write errors */ }
  }

  async buildIndex(workspaceRoot: string, opts: { force?: boolean } = {}): Promise<void> {
    if (this.building) { return; }
    this.building = true;

    const indexPath = this.getIndexPath(workspaceRoot);
    this.indexPath = indexPath;

    const existing = this.loadFromDisk(indexPath);
    const age = existing ? Date.now() - existing.builtAt : Infinity;
    if (!opts.force && existing && age < INDEX_TTL_MS) {
      this.index = existing;
      this.building = false;
      this.setupWatcher(workspaceRoot);
      return;
    }

    try {
      const pattern = new vscode.RelativePattern(workspaceRoot, "**/*");
      const uris = await vscode.workspace.findFiles(pattern, `{${BASE_EXCLUDE}}`, 2000);

      const newIndex: WorkspaceIndex = {
        version: INDEX_VERSION,
        workspaceRoot,
        builtAt: Date.now(),
        files: existing ? { ...existing.files } : {},
      };

      // Process in batches to avoid blocking the extension host
      const BATCH = 50;
      for (let i = 0; i < uris.length; i += BATCH) {
        const batch = uris.slice(i, i + BATCH);
        await Promise.all(batch.map(uri => this.indexFile(uri, workspaceRoot, newIndex)));
        await new Promise(r => setTimeout(r, 0)); // yield between batches
      }

      this.index = newIndex;
      this.saveToDisk(indexPath, newIndex);
      this.setupWatcher(workspaceRoot);
    } catch { /* silent — indexing is best-effort */ } finally {
      this.building = false;
    }
  }

  private async indexFile(
    uri: vscode.Uri,
    workspaceRoot: string,
    index: WorkspaceIndex
  ): Promise<void> {
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.type !== vscode.FileType.File) { return; }
      if (stat.size > MAX_FILE_BYTES) { return; }

      const relPath = vscode.workspace.asRelativePath(uri, false);
      const existing = index.files[relPath];
      if (existing && existing.lastModified === stat.mtime) { return; }

      const doc = await vscode.workspace.openTextDocument(uri);
      const symbols = await this.extractSymbols(uri);

      index.files[relPath] = {
        relPath,
        language: doc.languageId,
        symbols,
        lineCount: doc.lineCount,
        lastModified: stat.mtime,
      };
    } catch { /* skip unreadable files */ }
  }

  private async extractSymbols(uri: vscode.Uri): Promise<string[]> {
    try {
      const rawSymbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        "vscode.executeDocumentSymbolProvider",
        uri
      );
      if (!rawSymbols) { return []; }
      const names: string[] = [];
      const collect = (syms: vscode.DocumentSymbol[]) => {
        for (const s of syms) {
          names.push(s.name);
          if (s.children?.length) { collect(s.children); }
        }
      };
      collect(rawSymbols);
      return names;
    } catch {
      return [];
    }
  }

  async updateFile(uri: vscode.Uri): Promise<void> {
    if (!this.index || !this.indexPath) { return; }
    const workspaceRoot = this.index.workspaceRoot;
    await this.indexFile(uri, workspaceRoot, this.index);
    this.saveToDisk(this.indexPath, this.index);
  }

  removeFile(uri: vscode.Uri): void {
    if (!this.index || !this.indexPath) { return; }
    const relPath = vscode.workspace.asRelativePath(uri, false);
    if (relPath in this.index.files) {
      delete this.index.files[relPath];
      this.saveToDisk(this.indexPath, this.index);
    }
  }

  private setupWatcher(workspaceRoot: string): void {
    if (this.watcher) { this.watcher.dispose(); }
    const pattern = new vscode.RelativePattern(workspaceRoot, "**/*");
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
    this.watcher.onDidChange(uri => this.updateFile(uri));
    this.watcher.onDidCreate(uri => this.updateFile(uri));
    this.watcher.onDidDelete(uri => this.removeFile(uri));
    this.context.subscriptions.push(this.watcher);
  }

  /**
   * Score and return top N files relevant to a user message.
   * Scoring: path segment matches + symbol name matches (case-insensitive).
   */
  queryIndex(userMessage: string, topN = 8): IndexedFile[] {
    if (!this.index) { return []; }

    const tokens = new Set(
      userMessage
        .toLowerCase()
        .split(/[^a-z0-9_]+/)
        .filter(t => t.length > 2)
    );
    if (tokens.size === 0) { return []; }

    const scored: Array<{ file: IndexedFile; score: number }> = [];

    for (const file of Object.values(this.index.files)) {
      let score = 0;

      const pathTokens = file.relPath.toLowerCase().split(/[^a-z0-9]+/);
      for (const pt of pathTokens) {
        if (tokens.has(pt)) { score += 2; }
        else {
          for (const t of tokens) {
            if (pt.includes(t) || t.includes(pt)) { score += 1; }
          }
        }
      }

      for (const sym of file.symbols) {
        const symLower = sym.toLowerCase();
        if (tokens.has(symLower)) { score += 5; }
        else {
          for (const t of tokens) {
            if (symLower.includes(t)) { score += 2; }
          }
        }
      }

      if (score > 0) { scored.push({ file, score }); }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topN).map(s => s.file);
  }

  dispose(): void {
    this.watcher?.dispose();
  }
}
