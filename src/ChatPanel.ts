import * as vscode from "vscode";
import * as path from "path";
import { OdysseusClient } from "./api/client";
import { streamChat } from "./api/streaming";
import { DocSync } from "./sync/docSync";
import {
  getActiveFileContext,
  getSelectionContext,
  getWorkspaceRoot,
  buildDisplayMessage,
  buildApiMessage,
} from "./context/fileContext";

export class ChatPanel {
  public static readonly viewType = "odysseus.chatPanel";
  private static instances = new Set<ChatPanel>();
  private static _lastFocused: ChatPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private client?: OdysseusClient;
  private docSync?: DocSync;
  private sessionId?: string;
  private currentModel = "";
  private currentEndpointUrl = "";
  private disposables: vscode.Disposable[] = [];
  private pendingSessionId?: string;
  private contextUpdateTimer?: NodeJS.Timeout;
  private lastKnownFileCtx?: ReturnType<typeof getActiveFileContext>;
  private freshSession = false;
  private preEditSnapshots = new Map<string, string>();

  /** Called when the chat panel is disposed, so the sidebar can refresh its list. */
  public static onDidClose?: () => void;

  public static createOrShow(context: vscode.ExtensionContext, sessionId?: string): ChatPanel {
    // If a specific session is requested and already open, focus it
    if (sessionId) {
      for (const existing of ChatPanel.instances) {
        if (existing.sessionId === sessionId) {
          existing.panel.reveal(vscode.ViewColumn.Beside, true);
          return existing;
        }
      }
    }
    // If no sessionId and there's already a focused panel, just reveal it
    if (!sessionId && ChatPanel._lastFocused) {
      ChatPanel._lastFocused.panel.reveal(vscode.ViewColumn.Beside, true);
      return ChatPanel._lastFocused;
    }
    const webviewPanel = vscode.window.createWebviewPanel(
      ChatPanel.viewType,
      "Odysseus",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] }
    );
    const instance = new ChatPanel(webviewPanel, context, sessionId);
    ChatPanel.instances.add(instance);
    ChatPanel._lastFocused = instance;
    return instance;
  }

  public static getCurrent(): ChatPanel | undefined {
    return ChatPanel._lastFocused;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    sessionId?: string
  ) {
    this.panel = panel;
    this.pendingSessionId = sessionId;
    this.panel.iconPath = vscode.Uri.parse(
      "data:image/svg+xml," +
        encodeURIComponent(
          "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><path d='M16 4L16 22L6 22Z' fill='#e06c75'/><path d='M16 8L16 22L24 22Z' fill='#e06c75' opacity='0.6'/><path d='M4 24Q10 20 16 24Q22 28 28 24' stroke='#e06c75' stroke-width='2.5' fill='none' stroke-linecap='round'/></svg>"
        )
    );

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.onDidChangeViewState(({ webviewPanel }) => {
      if (webviewPanel.active) { ChatPanel._lastFocused = this; }
    }, null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (msg) => this.handleMessage(msg),
      null,
      this.disposables
    );

    vscode.window.onDidChangeActiveTextEditor(
      () => this.sendContextUpdate(),
      null,
      this.disposables
    );
    vscode.window.onDidChangeTextEditorSelection(
      () => this.scheduleContextUpdate(),
      null,
      this.disposables
    );

    this.panel.webview.html = this.buildHtml("loading");
    this.init();
  }

  private dispose(): void {
    if (this.contextUpdateTimer) { clearTimeout(this.contextUpdateTimer); }
    ChatPanel.instances.delete(this);
    if (ChatPanel._lastFocused === this) {
      // Pick any remaining instance as the focused one
      ChatPanel._lastFocused = ChatPanel.instances.values().next().value;
    }
    this.panel.dispose();
    for (const d of this.disposables) { d.dispose(); }
    this.disposables = [];
    ChatPanel.onDidClose?.();
  }

  private sendContextUpdate(): void {
    const fileCtx = getActiveFileContext();
    const selCtx  = getSelectionContext();
    // Only update lastKnownFileCtx when a real editor is focused — clicking into
    // the webview sets activeTextEditor to undefined, which should not clear the pill.
    if (fileCtx) { this.lastKnownFileCtx = fileCtx; }
    const displayFile = this.lastKnownFileCtx;
    this.postMessage({
      type: "contextUpdate",
      file: displayFile ? {
        name: displayFile.filePath.split("/").pop() ?? displayFile.filePath,
        path: displayFile.filePath,
        language: displayFile.language,
      } : null,
      selection: selCtx ? {
        startLine: selCtx.startLine,
        endLine: selCtx.endLine,
        language: selCtx.language,
      } : null,
    });
  }

  private scheduleContextUpdate(): void {
    if (this.contextUpdateTimer) { clearTimeout(this.contextUpdateTimer); }
    this.contextUpdateTimer = setTimeout(() => this.sendContextUpdate(), 150);
  }

  private getUrl(): string {
    return vscode.workspace
      .getConfiguration("odysseus")
      .get<string>("url", "http://localhost:7860");
  }

  private async init(): Promise<void> {
    this.panel.webview.html = this.buildHtml("loading");
    const url = this.getUrl();
    const token = await this.context.secrets.get("odysseus.token");
    this.client = new OdysseusClient(url, token);
    this.docSync = new DocSync(this.client);

    try {
      const status = await this.client.getAuthStatus();
      if (status.configured && !token) {
        // Auth required, no token stored yet
        this.panel.webview.html = this.buildHtml("auth");
        return;
      }
      // If auth is disabled OR we have a stored token, proceed.
      // Do NOT re-check status.authenticated — that endpoint uses session
      // cookies and will always return false for Bearer token callers.
    } catch {
      this.panel.webview.html = this.buildHtml("disconnected");
      return;
    }

    await this.ensureSession();
    this.panel.webview.html = this.buildHtml("chat", this.currentModel);
    // Also send immediately after a short delay — postMessage may drop if webview isn't ready yet
    setTimeout(() => this.sendModelsToWebview(), 300);
    setTimeout(() => this.sendModelsToWebview(), 1000);
    setTimeout(() => this.sendContextUpdate(), 600);
  }

  /** Switch the panel to an existing session (from the history sidebar). */
  async loadSession(sessionId: string): Promise<void> {
    if (!this.client || !sessionId) { return; }
    this.pendingSessionId = sessionId;
    this.docSync?.reset();
    await this.ensureSession();
    this.postMessage({ type: "clearMessages" });

    // Resolve human-readable name upfront for fallback divider
    const session = await this.client.getSession(sessionId).catch(() => null);
    const sessionName = session?.name ?? "session";

    // Try to load message history from backend
    try {
      const messages = await this.client.getSessionMessages(sessionId);
      if (messages.length > 0) {
        this.postMessage({ type: "loadHistory", messages });
      } else {
        this.postMessage({ type: "sessionSwitched", sessionName });
      }
    } catch {
      this.postMessage({ type: "sessionSwitched", sessionName });
    }

    this.panel.reveal(vscode.ViewColumn.Beside, true);
  }

  private async ensureSession(): Promise<void> {
    // If a specific session was requested (history sidebar), load it directly.
    if (this.pendingSessionId && this.client) {
      const id = this.pendingSessionId;
      this.pendingSessionId = undefined;
      const existing = await this.client.getSession(id);
      if (existing) {
        this.sessionId = id;
        if (existing.model)        { this.currentModel = existing.model; }
        if (existing.endpoint_url) { this.currentEndpointUrl = existing.endpoint_url; }
        await this.context.workspaceState.update("odysseus.sessionId", id);
        return;
      }
      // Fall through to normal resolution if the session no longer exists.
    }

    const savedId = this.context.workspaceState.get<string>("odysseus.sessionId");
    if (savedId && this.client) {
      const existing = await this.client.getSession(savedId);
      if (existing && existing.model) {
        this.sessionId = savedId;
        this.currentModel = existing.model;
        this.currentEndpointUrl = existing.endpoint_url ?? "";
        return;
      }
      await this.context.workspaceState.update("odysseus.sessionId", undefined);
    }
    if (!this.client) { return; }
    const folderName = vscode.workspace.workspaceFolders?.[0]?.name ?? "VS Code";
    const session = await this.client.createSession(
      `${folderName} (VS Code)`,
      this.currentModel || undefined,
      this.currentEndpointUrl || undefined
    );
    this.sessionId = session.id;
    if (session.model)        { this.currentModel = session.model; }
    if (session.endpoint_url) { this.currentEndpointUrl = session.endpoint_url; }
    await this.context.workspaceState.update("odysseus.sessionId", session.id);
  }

  async newSession(): Promise<void> {
    if (!this.client) { return; }
    this.sessionId = undefined;
    await this.context.workspaceState.update("odysseus.sessionId", undefined);
    this.docSync?.reset();
    await this.createFreshSession();
    this.postMessage({ type: "clearMessages" });
  }

  private async createFreshSession(): Promise<void> {
    if (!this.client) { return; }
    const folderName = vscode.workspace.workspaceFolders?.[0]?.name ?? "VS Code";
    const ts = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const name = `${folderName} (VS Code) ${ts}`;
    const session = await this.client.createSession(
      name,
      this.currentModel || undefined,
      this.currentEndpointUrl || undefined
    );
    console.log(`[Odysseus] createFreshSession: name="${name}" → id=${session.id}`);
    this.freshSession = true;
    this.sessionId = session.id;
    if (session.model)        { this.currentModel = session.model; }
    if (session.endpoint_url) { this.currentEndpointUrl = session.endpoint_url; }
    await this.context.workspaceState.update("odysseus.sessionId", session.id);
  }

  prefillPrompt(text: string): void {
    this.postMessage({ type: "prefillPrompt", text });
  }

  getPreEditSnapshot(filePath: string): string | undefined {
    return this.preEditSnapshots.get(filePath);
  }

  /** Search all open panels for a pre-edit snapshot — used by the content provider. */
  public static getPreEditSnapshotFromAny(filePath: string): string | undefined {
    for (const instance of ChatPanel.instances) {
      const snap = instance.getPreEditSnapshot(filePath);
      if (snap !== undefined) { return snap; }
    }
    return undefined;
  }

  /** Always creates a fresh panel regardless of existing instances. */
  public static createNewPanel(context: vscode.ExtensionContext): ChatPanel {
    const webviewPanel = vscode.window.createWebviewPanel(
      ChatPanel.viewType,
      "Odysseus",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] }
    );
    const instance = new ChatPanel(webviewPanel, context, undefined);
    ChatPanel.instances.add(instance);
    ChatPanel._lastFocused = instance;
    return instance;
  }

  insertAtMention(): void {
    const fileCtx = getActiveFileContext() ?? this.lastKnownFileCtx;
    if (!fileCtx) { return; }
    const basename = fileCtx.filePath.split("/").pop() ?? fileCtx.filePath;
    const sel = getSelectionContext();
    const ref = sel
      ? `@${basename}:${sel.startLine}-${sel.endLine}`
      : `@${basename}`;
    this.panel.reveal(vscode.ViewColumn.Beside, true);
    this.postMessage({ type: "insertAtMention", ref });
  }

  async sendSelection(): Promise<void> {
    const sel = getSelectionContext();
    if (!sel) {
      vscode.window.showInformationMessage("Odysseus: no text selected.");
      return;
    }
    this.panel.reveal(vscode.ViewColumn.Beside, true);
    this.postMessage({
      type: "prefillSelection",
      filePath: sel.filePath ?? "",
      startLine: sel.startLine,
      endLine: sel.endLine,
      language: sel.language,
      text: sel.text,
    });
  }

  private async sendModelsToWebview(): Promise<void> {
    if (!this.client) {
      console.error("[Odysseus] sendModelsToWebview: no client");
      return;
    }
    try {
      const models = await this.client.listAvailableModels();
      console.log(`[Odysseus] models loaded: ${models.length}, currentModel: ${this.currentModel}`);
      this.postMessage({ type: "modelsLoaded", models, currentModel: this.currentModel });
    } catch (err) {
      console.error("[Odysseus] sendModelsToWebview failed:", err);
      // Still send the current model so the picker isn't stuck on "Loading…"
      this.postMessage({ type: "modelsLoaded", models: [], currentModel: this.currentModel });
    }
  }

  private async handleMessage(msg: { type: string; [k: string]: unknown }): Promise<void> {
    switch (msg.type) {
      case "_jsError":    console.error("[Odysseus] webview JS error:", msg.text); break;
      case "send":        await this.handleSend(String(msg.text ?? ""), msg.opts as SendOpts); break;
      case "requestModels": await this.sendModelsToWebview(); break;
      case "selectModel": await this.handleSelectModel(String(msg.model ?? ""), String(msg.endpointUrl ?? "")); break;
      case "newSession":  await this.newSession(); break;
      case "requestFiles": await this.handleRequestFiles(String(msg.query ?? "")); break;
      case "revertEdit":  await this.handleRevertEdit(String(msg.path ?? "")); break;
      case "viewDiff":    await this.handleViewDiff(String(msg.path ?? "")); break;
      case "retry":       await this.init(); break;
      case "login":       await this.handleLogin(String(msg.username ?? ""), String(msg.password ?? ""), String(msg.totp ?? "")); break;
      case "setUrl":      await this.handleSetUrl(String(msg.url ?? "")); break;
    }
  }

  private async handleSelectModel(model: string, endpointUrl: string): Promise<void> {
    if (!model || !this.client || !this.sessionId) { return; }
    this.currentModel = model;
    this.currentEndpointUrl = endpointUrl;
    try {
      await this.client.updateSessionModel(this.sessionId, model, endpointUrl);
    } catch { /* stored for next session */ }
    this.postMessage({ type: "modelChanged", model });
  }

  private async handleSetUrl(url: string): Promise<void> {
    const trimmed = url.trim();
    if (!trimmed) { return; }
    await vscode.workspace.getConfiguration("odysseus")
      .update("url", trimmed, vscode.ConfigurationTarget.Global);
    await this.init();
  }

  private async handleLogin(username: string, password: string, totp: string): Promise<void> {
    const url = this.getUrl();
    if (!this.client) { this.client = new OdysseusClient(url); }
    const result = await this.client.login(username, password, totp || undefined);

    if (result.requiresTotp) {
      this.postMessage({ type: "requireTotp" });
      return;
    }
    if (!result.ok || !result.token) {
      this.postMessage({ type: "authError", message: result.error ?? "Login failed." });
      return;
    }

    await this.context.secrets.store("odysseus.token", result.token);
    this.client = new OdysseusClient(url, result.token);
    this.docSync = new DocSync(this.client);
    await this.ensureSession();
    this.panel.webview.html = this.buildHtml("chat", this.currentModel);
    setTimeout(() => this.sendModelsToWebview(), 300);
    setTimeout(() => this.sendModelsToWebview(), 1000);
  }

  private async handleRevertEdit(filePath: string): Promise<void> {
    if (!filePath) { return; }
    const original = this.preEditSnapshots.get(filePath);
    if (original === undefined) {
      vscode.window.showWarningMessage("Odysseus: no pre-edit snapshot for this file.");
      return;
    }
    try {
      await vscode.workspace.fs.writeFile(
        vscode.Uri.file(filePath),
        Buffer.from(original, "utf-8")
      );
    } catch (err) {
      vscode.window.showErrorMessage(`Odysseus: revert failed — ${String(err)}`);
    }
  }

  private async handleViewDiff(filePath: string): Promise<void> {
    if (!filePath || !this.preEditSnapshots.has(filePath)) { return; }
    const basename = filePath.split("/").pop() ?? filePath;
    const originalUri = vscode.Uri.parse(`odysseus-original:${filePath}`);
    await vscode.commands.executeCommand(
      "vscode.diff",
      originalUri,
      vscode.Uri.file(filePath),
      `Odysseus: ${basename} (original ↔ modified)`,
      { preview: true }
    );
  }

  private async handleRequestFiles(query: string): Promise<void> {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
      this.postMessage({ type: "filesResult", files: [] });
      return;
    }
    const pattern = new vscode.RelativePattern(workspaceRoot, "**/*");
    const uris = await vscode.workspace.findFiles(pattern, "**/node_modules/**", 30);
    const q = query.toLowerCase();
    const files = uris
      .filter(u => {
        const name = u.fsPath.split("/").pop() ?? "";
        return !q || name.toLowerCase().includes(q);
      })
      .slice(0, 20)
      .map(u => ({
        name: u.fsPath.split("/").pop() ?? "",
        path: u.fsPath,
        relativePath: vscode.workspace.asRelativePath(u, false),
      }));
    this.postMessage({ type: "filesResult", files });
  }

  private async handleSend(text: string, opts: SendOpts = {}): Promise<void> {
    if (!text.trim() || !this.client || !this.sessionId || !this.docSync) { return; }

    const token = await this.context.secrets.get("odysseus.token");
    const url = this.getUrl();
    const cfg = vscode.workspace.getConfiguration("odysseus");
    const agentMode      = opts.agentMode      ?? cfg.get<boolean>("agentMode", true);
    const allowBash      = opts.allowBash      ?? cfg.get<boolean>("allowBash", true);
    const allowWebSearch = opts.allowWebSearch ?? cfg.get<boolean>("allowWebSearch", true);

    await vscode.workspace.saveAll(false); // save dirty docs so agent reads fresh disk content

    const fileCtx = opts.includeFile !== false ? (getActiveFileContext() ?? this.lastKnownFileCtx ?? null) : null;

    // Snapshot files before agent runs so we can show diffs afterward
    this.preEditSnapshots.clear();
    if (fileCtx) {
      try {
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(fileCtx.filePath));
        this.preEditSnapshots.set(fileCtx.filePath, Buffer.from(bytes).toString("utf-8"));
      } catch { /* new file or unreadable */ }
    }
    const selCtx  = opts.includeSelection !== false ? getSelectionContext() : null;
    const workspaceRoot = getWorkspaceRoot();

    const displayMessage = buildDisplayMessage(text, selCtx);
    const isFresh = this.freshSession;
    this.freshSession = false;
    let apiMessage = await buildApiMessage(displayMessage, workspaceRoot, fileCtx, isFresh);

    // Resolve @-mention tokens → inject file contents into the API message
    const atMentions = [...text.matchAll(/@([\w./\-]+)/g)].map(m => m[1]);
    for (const ref of atMentions) {
      const absPath = workspaceRoot ? path.resolve(workspaceRoot, ref) : ref;
      try {
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(absPath));
        const content = Buffer.from(bytes).toString("utf-8").slice(0, 10000);
        apiMessage += `\n<referenced_file path="${ref}">\n${content}\n</referenced_file>`;
      } catch { /* file not found or unreadable — skip */ }
    }

    this.postMessage({ type: "userMessage", text: displayMessage });
    this.postMessage({ type: "assistantStart" });

    const writtenPaths: string[] = [];

    try {
      await streamChat({
        baseUrl: url,
        token,
        sessionId: this.sessionId,
        message: apiMessage,
        activeDocId: undefined,   // don't use DBDocument — let agent write to real filesystem
        agentMode,
        allowBash,
        allowWebSearch,
        onEvent: (event) => {
          this.postMessage({ type: "streamEvent", event });
          // Track files written by the agent so we can refresh them in VS Code
          if (event.type === "tool_output" && event.exit_code === 0) {
            const path = parseWrittenPath(event.tool, event.output);
            if (path) { writtenPaths.push(path); }
          }
        },
      });
    } catch (err) {
      this.postMessage({ type: "streamEvent", event: { type: "error", message: String(err) } });
    }

    this.postMessage({ type: "assistantDone" });

    // Refresh any files the agent wrote to disk, show diff for modified files
    for (const p of writtenPaths) {
      try {
        const uri = vscode.Uri.file(p);
        const doc = await vscode.workspace.openTextDocument(uri);
        const editor = vscode.window.visibleTextEditors.find(
          (e) => e.document.uri.fsPath === p
        );
        if (editor) {
          await vscode.commands.executeCommand("workbench.action.files.revert");
        } else {
          await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true });
        }
        // Show diff if we have a pre-edit snapshot for this file
        if (this.preEditSnapshots.has(p)) {
          const basename = p.split("/").pop() ?? p;
          const originalUri = vscode.Uri.parse(`odysseus-original:${p}`);
          await vscode.commands.executeCommand(
            "vscode.diff",
            originalUri,
            uri,
            `Odysseus: ${basename} (original ↔ modified)`,
            { preview: true }
          );
          this.postMessage({ type: "editProposed", path: p });
        }
      } catch { /* file may not exist yet or path is outside workspace */ }
    }
  }

  private postMessage(msg: unknown): void {
    this.panel.webview.postMessage(msg);
  }

  private getUseCtrlEnter(): boolean {
    return vscode.workspace
      .getConfiguration("odysseus")
      .get<boolean>("useCtrlEnterToSend", false);
  }

  private buildHtml(state: "loading" | "disconnected" | "auth" | "chat", initialModel?: string): string {
    const useCtrlEnter = this.getUseCtrlEnter();
    const nonce = generateNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Odysseus</title>
<style nonce="${nonce}">
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size, 13px);
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
  height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* ── State screens ─────────────────────────────── */
#state-view {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  padding: 32px;
  text-align: center;
}
#state-view h2 { font-size: 15px; font-weight: 600; }
#state-view p  { font-size: 12px; opacity: 0.65; line-height: 1.6; max-width: 320px; }

.btn {
  display: inline-block;
  padding: 7px 18px;
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  border-radius: 5px;
  border: none;
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  min-width: 140px;
}
.btn:hover { background: var(--vscode-button-hoverBackground); }
.btn.secondary {
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
}
.btn.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }

.url-input {
  width: 100%;
  max-width: 280px;
  padding: 5px 10px;
  font-size: 12px;
  font-family: inherit;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, #444);
  border-radius: 4px;
  outline: none;
}
.url-input:focus { border-color: var(--vscode-focusBorder); }
.error-msg { color: var(--vscode-errorForeground); font-size: 11px; }
.spinner {
  width: 16px; height: 16px;
  border: 2px solid var(--vscode-foreground);
  border-top-color: transparent;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  opacity: 0.4;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* ── Chat layout ───────────────────────────────── */
#chat-view {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  max-width: 900px;
  margin: 0 auto;
  width: 100%;
  padding: 0 0 8px 0;
}

#messages {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  scroll-behavior: smooth;
}

.msg { display: flex; flex-direction: column; gap: 4px; }
.msg-role {
  font-size: 11px;
  font-weight: 600;
  opacity: 0.45;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.msg-body {
  font-size: 13px;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
}
.msg.user .msg-body {
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-editorWidget-border, rgba(255,255,255,0.08));
  padding: 8px 12px;
  border-radius: 8px;
  align-self: flex-end;
  max-width: 85%;
}

.tool-wrap { display: flex; flex-direction: column; margin: 4px 0; }
.tool-chip {
  display: flex;
  align-items: center;
  gap: 7px;
  background: var(--vscode-editorWidget-background);
  border: 1px solid var(--vscode-editorWidget-border, rgba(255,255,255,0.08));
  border-radius: 6px 6px 0 0;
  padding: 6px 10px;
  font-size: 11px;
  cursor: pointer;
  width: 100%;
  text-align: left;
  color: inherit;
}
.tool-chip.no-output { border-radius: 6px; }
.tool-badge {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 3px;
  background: var(--vscode-badge-background, rgba(255,255,255,0.12));
  color: var(--vscode-badge-foreground);
  flex-shrink: 0;
  font-family: var(--vscode-editor-font-family, monospace);
}
.tool-badge.bash-badge   { background: rgba(100,180,100,0.2); color: #7ec57e; }
.tool-badge.search-badge { background: rgba(100,150,220,0.2); color: #7eb8e0; }
.tool-badge.write-badge  { background: rgba(220,170,80,0.2);  color: #e0c47e; }
.tool-name  { font-weight: 500; }
.tool-cmd   {
  opacity: 0.65;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 11px;
}
.tool-status { flex-shrink: 0; font-size: 12px; }
.tool-chip.running .tool-status { opacity: 0.5; animation: blink 1s step-end infinite; }
.tool-chip.running .tool-status::after { content: "⋯"; }
.tool-chip.success .tool-status::after { content: "✓"; color: #4caf50; }
.tool-chip.error   .tool-status::after { content: "✗"; color: #f44336; }
.tool-output {
  background: var(--vscode-terminal-background, #1a1a1a);
  color: var(--vscode-terminal-foreground, #ccc);
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 11.5px;
  padding: 8px 12px;
  border-radius: 0 0 6px 6px;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 320px;
  overflow-y: auto;
  border: 1px solid var(--vscode-editorWidget-border, rgba(255,255,255,0.08));
  border-top: none;
  display: none;
  line-height: 1.5;
}
.tool-output.open { display: block; }

/* Verbose: tool input args */
.tool-input {
  display: none;
  background: var(--vscode-textCodeBlock-background, rgba(255,255,255,0.04));
  color: var(--vscode-foreground);
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 11px;
  padding: 6px 10px;
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  border-left: 1px solid var(--vscode-editorWidget-border, rgba(255,255,255,0.08));
  border-right: 1px solid var(--vscode-editorWidget-border, rgba(255,255,255,0.08));
  opacity: 0.8;
  max-height: 200px;
  overflow-y: auto;
}
body.verbose .tool-input.has-input { display: block; }

/* Reasoning steps count header */
.chat-header {
  display: none;
  align-items: center;
  gap: 8px;
  padding: 6px 20px;
  font-size: 11px;
  opacity: 0.55;
  border-bottom: 1px solid var(--vscode-editorWidget-border, rgba(255,255,255,0.06));
  font-variant-numeric: tabular-nums;
}
body.verbose .chat-header { display: flex; }

/* Thinking block — matches Odysseus style */
.thinking-section {
  margin: 4px 0 6px;
  border: 1px solid rgba(224,108,117,0.25);
  border-radius: 8px;
  background: rgba(224,108,117,0.05);
  overflow: hidden;
}
.thinking-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 5px 10px;
  cursor: pointer;
  user-select: none;
  background: rgba(224,108,117,0.08);
  border-bottom: 1px solid rgba(224,108,117,0.15);
  font-size: 11px;
  color: #e06c75;
  font-weight: 500;
}
.thinking-header:hover { background: rgba(224,108,117,0.13); }
.thinking-header-left { display: flex; align-items: center; gap: 6px; overflow: hidden; }
.thinking-label { white-space: nowrap; }
.thinking-preview {
  opacity: 0.6;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 400;
  flex: 1;
  font-size: 10.5px;
}
.thinking-chevron { transition: transform 0.2s; flex-shrink: 0; }
.thinking-chevron.open { transform: rotate(180deg); }
.thinking-content {
  max-height: 0;
  overflow: hidden;
  transition: max-height 0.25s ease, padding 0.2s;
  padding: 0 12px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--vscode-foreground);
  opacity: 0.75;
  font-family: var(--vscode-editor-font-family, monospace);
  white-space: pre-wrap;
  word-break: break-word;
}
.thinking-content.open {
  max-height: 400px;
  overflow-y: auto;
  padding: 8px 12px;
}

.round-header {
  font-size: 10px;
  opacity: 0.35;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  margin: 8px 0 4px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.round-header::after {
  content: '';
  flex: 1;
  height: 1px;
  background: currentColor;
  opacity: 0.2;
}
.step-badge { font-size: 10px; opacity: 0.4; font-style: italic; }
.cursor::after { content: "▌"; animation: blink 1s step-end infinite; opacity: 0.7; }
@keyframes blink { 50% { opacity: 0; } }

/* ── Context pills ─────────────────────────────── */
.context-pills {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 6px 12px 0;
  min-height: 0;
}
.context-pills:empty { padding: 0; }
.context-pill {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 4px 2px 8px;
  border-radius: 4px;
  border: 1px solid rgba(224,108,117,0.3);
  background: rgba(224,108,117,0.08);
  font-size: 11px;
  color: var(--vscode-foreground);
  max-width: 240px;
}
.context-pill-icon { opacity: 0.65; flex-shrink: 0; }
.context-pill-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.85;
  font-family: var(--vscode-editor-font-family, monospace);
}
.context-pill-close {
  font-size: 14px;
  line-height: 1;
  opacity: 0.4;
  cursor: pointer;
  padding: 0 3px;
  border: none;
  background: none;
  color: inherit;
  flex-shrink: 0;
}
.context-pill-close:hover { opacity: 1; }

/* ── Chat input bar (matches Odysseus) ─────────── */
.chat-input-bar {
  margin: 0 16px 4px;
  border: 1px solid var(--vscode-input-border, rgba(255,255,255,0.15));
  border-radius: 10px;
  background: var(--vscode-input-background);
  display: flex;
  flex-direction: column;
  transition: border-color 0.15s;
}
.chat-input-bar:focus-within {
  border-color: var(--vscode-focusBorder, rgba(255,255,255,0.3));
}

.chat-input-top {
  position: relative;
  display: flex;
  align-items: flex-start;
}
#message {
  flex: 1;
  border: none;
  background: transparent;
  color: var(--vscode-input-foreground);
  padding: 10px 130px 10px 14px;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.55;
  resize: none;
  outline: none;
  min-height: 44px;
  max-height: 200px;
  overflow-y: auto;
}
#message::placeholder { opacity: 0.4; }

/* Model picker — inside textarea top-right, matches Odysseus */
.model-picker-wrap {
  position: absolute;
  top: 7px;
  right: 9px;
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 4px;
}
.new-chat-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 4px;
  border: 1px solid var(--vscode-editorWidget-border, rgba(255,255,255,0.12));
  background: var(--vscode-editorWidget-background, rgba(255,255,255,0.06));
  color: var(--vscode-foreground);
  cursor: pointer;
  font-size: 15px;
  line-height: 1;
  opacity: 0.55;
  flex-shrink: 0;
  padding: 0;
  font-family: inherit;
}
.new-chat-btn:hover { opacity: 1; border-color: var(--vscode-focusBorder); }
.model-picker-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  font-size: 11px;
  font-family: inherit;
  cursor: pointer;
  border-radius: 5px;
  border: 1px solid var(--vscode-editorWidget-border, rgba(255,255,255,0.12));
  background: var(--vscode-editorWidget-background, rgba(255,255,255,0.06));
  color: var(--vscode-foreground);
  max-width: 160px;
  white-space: nowrap;
  overflow: hidden;
}
.model-picker-btn:hover { border-color: var(--vscode-focusBorder); }
.picker-label {
  overflow: hidden;
  text-overflow: ellipsis;
  opacity: 0.75;
  max-width: 120px;
}
.picker-chevron { flex-shrink: 0; opacity: 0.45; transition: transform 0.15s; }
.picker-chevron.open { transform: rotate(180deg); }

.model-picker-menu {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  width: 260px;
  background: var(--vscode-editorWidget-background);
  border: 1px solid var(--vscode-editorWidget-border, rgba(255,255,255,0.15));
  border-radius: 8px;
  box-shadow: 0 6px 20px rgba(0,0,0,0.4);
  z-index: 200;
  display: none;
  flex-direction: column;
  overflow: hidden;
}
.model-picker-menu.open { display: flex; }
.model-search-row {
  display: flex;
  align-items: center;
  border-bottom: 1px solid var(--vscode-editorWidget-border, rgba(255,255,255,0.08));
}
#model-search {
  flex: 1;
  padding: 8px 10px;
  border: none;
  background: transparent;
  color: var(--vscode-foreground);
  font-size: 12px;
  font-family: inherit;
  outline: none;
}
.model-picker-list { overflow-y: auto; max-height: 220px; }
.model-item {
  padding: 8px 12px;
  font-size: 12px;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.model-item:hover, .model-item.kb-active { background: var(--vscode-list-hoverBackground); }
.model-item.selected .model-item-name { color: var(--vscode-button-background); }
.model-item-name { font-weight: 500; }
.model-item-ep   { font-size: 10px; opacity: 0.45; }
.model-empty { padding: 12px; font-size: 11px; opacity: 0.45; text-align: center; }

/* Bottom toolbar */
.chat-input-bottom {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 5px 10px 7px;
  border-top: 1px solid var(--vscode-editorWidget-border, rgba(255,255,255,0.07));
}
.chat-input-left, .chat-input-right { display: flex; align-items: center; gap: 4px; }

.icon-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 4px 8px;
  border-radius: 5px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--vscode-foreground);
  opacity: 0.5;
  cursor: pointer;
  font-size: 11px;
  font-family: inherit;
}
.icon-btn:hover  { opacity: 0.85; background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.06)); }
.icon-btn.active { opacity: 1; border-color: var(--vscode-focusBorder, rgba(255,255,255,0.2)); background: var(--vscode-toolbar-activeBackground, rgba(255,255,255,0.08)); }
.icon-btn svg { flex-shrink: 0; }

.mode-toggle {
  display: flex;
  border: 1px solid var(--vscode-editorWidget-border, rgba(255,255,255,0.12));
  border-radius: 5px;
  overflow: hidden;
}
.mode-btn {
  padding: 3px 10px;
  font-size: 11px;
  font-family: inherit;
  border: none;
  background: transparent;
  color: var(--vscode-foreground);
  opacity: 0.5;
  cursor: pointer;
}
.mode-btn.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); opacity: 1; }

.send-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 6px;
  border: none;
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  cursor: pointer;
  flex-shrink: 0;
}
.send-btn:hover   { background: var(--vscode-button-hoverBackground); }
.send-btn:disabled { opacity: 0.35; cursor: not-allowed; }

.msg-status {
  font-size: 11px;
  font-style: italic;
  color: var(--vscode-descriptionForeground);
  margin-top: 6px;
  opacity: 0.8;
}

/* ── @-mention picker ───────────────────────────── */
.at-picker {
  position: absolute;
  bottom: calc(100% + 4px);
  left: 0;
  right: 0;
  background: var(--vscode-editorWidget-background);
  border: 1px solid var(--vscode-editorWidget-border, rgba(255,255,255,0.15));
  border-radius: 8px;
  box-shadow: 0 6px 20px rgba(0,0,0,0.4);
  z-index: 200;
  display: none;
  flex-direction: column;
  overflow: hidden;
  max-height: 200px;
  overflow-y: auto;
}
.at-picker.open { display: flex; }
.at-picker-item {
  padding: 7px 12px;
  font-size: 12px;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-family: var(--vscode-editor-font-family, monospace);
}
.at-picker-item:hover, .at-picker-item.kb-active { background: var(--vscode-list-hoverBackground); }
.at-picker-rel { font-size: 10px; opacity: 0.45; }

/* ── Slash command menu ─────────────────────────── */
.slash-menu {
  position: absolute;
  bottom: calc(100% + 4px);
  left: 0;
  right: 0;
  background: var(--vscode-editorWidget-background);
  border: 1px solid var(--vscode-editorWidget-border, rgba(255,255,255,0.15));
  border-radius: 8px;
  box-shadow: 0 6px 20px rgba(0,0,0,0.4);
  z-index: 200;
  display: none;
  flex-direction: column;
  overflow: hidden;
  max-height: 240px;
  overflow-y: auto;
}
.slash-menu.open { display: flex; }
.slash-menu-item {
  padding: 8px 12px;
  font-size: 12px;
  cursor: pointer;
  display: flex;
  gap: 10px;
  align-items: baseline;
}
.slash-menu-item:hover, .slash-menu-item.kb-active { background: var(--vscode-list-hoverBackground); }
.slash-cmd { font-weight: 600; font-family: var(--vscode-editor-font-family, monospace); }
.slash-desc { font-size: 11px; opacity: 0.55; }

/* ── Edit proposal bar ──────────────────────────── */
.edit-proposal {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  background: rgba(224,108,117,0.08);
  border: 1px solid rgba(224,108,117,0.25);
  border-radius: 6px;
  font-size: 11px;
  margin: 4px 0;
  flex-wrap: wrap;
}
.edit-proposal-name { font-family: var(--vscode-editor-font-family, monospace); flex: 1; }
.edit-proposal-btn {
  padding: 2px 8px;
  font-size: 11px;
  font-family: inherit;
  border-radius: 4px;
  border: 1px solid var(--vscode-editorWidget-border, rgba(255,255,255,0.15));
  background: var(--vscode-editorWidget-background);
  color: var(--vscode-foreground);
  cursor: pointer;
}
.edit-proposal-btn:hover { background: var(--vscode-list-hoverBackground); }

/* ── Context indicator ──────────────────────────── */
.context-indicator {
  display: none;
  align-items: center;
  gap: 8px;
  padding: 4px 20px;
  font-size: 11px;
  opacity: 0.55;
  border-bottom: 1px solid var(--vscode-editorWidget-border, rgba(255,255,255,0.06));
  font-variant-numeric: tabular-nums;
}
.context-indicator.visible { display: flex; }
</style>
</head>
<body>

${state === "loading" ? `
<div id="state-view">
  <div class="spinner"></div>
  <p>Connecting to Odysseus…</p>
</div>` : ""}

${state === "disconnected" ? `
<div id="state-view">
  <h2>Odysseus not found</h2>
  <p>Make sure Odysseus is running, then set the correct server URL.</p>
  <input class="url-input" id="url-input" type="text" placeholder="http://localhost:7860">
  <button class="btn" id="url-btn">Set URL &amp; retry</button>
  <button class="btn secondary" id="retry-btn">Retry</button>
</div>` : ""}

${state === "auth" ? `
<div id="state-view">
  <h2>Sign in to Odysseus</h2>
  <input class="url-input" id="login-user" type="text" placeholder="Username" autocomplete="username" autocapitalize="off" spellcheck="false">
  <input class="url-input" id="login-pass" type="password" placeholder="Password" autocomplete="current-password">
  <input class="url-input" id="login-totp" type="text" placeholder="2FA code" inputmode="numeric" autocomplete="one-time-code" style="display:none">
  <div class="error-msg" id="auth-error" style="display:none"></div>
  <button class="btn" id="login-btn">Sign in</button>
</div>` : ""}

${state === "chat" ? `
<div id="chat-view">
  <div class="chat-header" id="chat-header">
    <span id="reasoning-count">0 tool calls · 0 thinking blocks</span>
  </div>
  <div class="context-indicator" id="context-indicator">
    <span id="context-token-est">~0 tokens used</span>
  </div>
  <div id="messages"></div>

  <div class="chat-input-bar">
    <div class="context-pills" id="context-pills"></div>
    <div class="chat-input-top" style="position:relative;">
      <div class="at-picker" id="at-picker"></div>
      <div class="slash-menu" id="slash-menu"></div>
      <textarea id="message" placeholder="Message Odysseus…" rows="1" autocomplete="off" spellcheck="false"></textarea>
      <div class="model-picker-wrap">
        <button class="new-chat-btn" id="new-chat-panel-btn" title="New Chat">+</button>
        <button class="model-picker-btn" id="model-picker-btn" title="Switch model">
          <span class="picker-label" id="picker-label">${initialModel || "Loading…"}</span>
          <svg class="picker-chevron" id="picker-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 15 12 9 18 15"/></svg>
        </button>
        <div class="model-picker-menu" id="model-picker-menu">
          <div class="model-search-row">
            <input id="model-search" type="text" placeholder="Search models…" autocomplete="off" spellcheck="false">
          </div>
          <div class="model-picker-list" id="model-list"></div>
        </div>
      </div>
    </div>
    <div class="chat-input-bottom">
      <div class="chat-input-left">
        <button class="icon-btn active" id="web-btn" title="Web search">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <span>Web</span>
        </button>
        <button class="icon-btn active" id="bash-btn" title="Shell commands">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
          <span>Terminal</span>
        </button>
        <button class="icon-btn" id="verbose-btn" title="Verbose — show thinking &amp; tool args (Ctrl+O toggles all)">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
          <span>Verbose</span>
        </button>
      </div>
      <div class="chat-input-right">
        <div class="mode-toggle">
          <button class="mode-btn active" id="mode-agent">Agent</button>
          <button class="mode-btn" id="mode-chat">Chat</button>
        </div>
        <button class="send-btn" id="send-btn" disabled title="Send (${useCtrlEnter ? "Ctrl+Enter" : "Enter"})">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>
        </button>
      </div>
    </div>
  </div>
</div>` : ""}

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const USE_CTRL_ENTER = ${useCtrlEnter ? "true" : "false"};
window.onerror = (msg, src, line, col, err) => {
  const text = (err ? err.toString() : String(msg)) + ' (' + line + ':' + col + ')';
  try { vscode.postMessage({ type: '_jsError', text }); } catch {}
};
console.log('[OdysseusWebview] script start');

/* ── State screens ──────────────────────────────── */
const retryBtn   = document.getElementById('retry-btn');
const urlBtn     = document.getElementById('url-btn');
const urlInput   = document.getElementById('url-input');
const authError  = document.getElementById('auth-error');
if (retryBtn)   retryBtn.onclick   = () => vscode.postMessage({ type: 'retry' });
if (urlBtn)     urlBtn.onclick     = () => vscode.postMessage({ type: 'setUrl', url: urlInput?.value ?? '' });
if (urlInput)   urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') urlBtn?.click(); });

/* ── Login form ─────────────────────────────────── */
const loginBtn  = document.getElementById('login-btn');
const loginUser = document.getElementById('login-user');
const loginPass = document.getElementById('login-pass');
const loginTotp = document.getElementById('login-totp');
function submitLogin() {
  if (!loginUser || !loginPass) return;
  const username = loginUser.value.trim();
  const password = loginPass.value;
  const totp = loginTotp && loginTotp.style.display !== 'none' ? loginTotp.value.trim() : '';
  if (!username || !password) {
    if (authError) { authError.textContent = 'Enter username and password.'; authError.style.display = ''; }
    return;
  }
  if (authError) authError.style.display = 'none';
  if (loginBtn) { loginBtn.disabled = true; loginBtn.textContent = 'Signing in…'; }
  vscode.postMessage({ type: 'login', username, password, totp });
}
if (loginBtn) loginBtn.onclick = submitLogin;
[loginUser, loginPass, loginTotp].forEach(el => {
  if (el) el.addEventListener('keydown', e => { if (e.key === 'Enter') submitLogin(); });
});
if (loginUser) setTimeout(() => loginUser.focus(), 50);

/* ── Model picker ───────────────────────────────── */
const pickerBtn    = document.getElementById('model-picker-btn');
const pickerMenu   = document.getElementById('model-picker-menu');
const pickerLabel  = document.getElementById('picker-label');
const pickerChevron= document.getElementById('picker-chevron');
const modelSearch  = document.getElementById('model-search');
const modelList    = document.getElementById('model-list');
let allModels = [];
let currentModel = '';
let pickerOpen = false;

function openPicker() {
  if (!pickerMenu) return;
  pickerOpen = true;
  pickerMenu.classList.add('open');
  pickerChevron?.classList.add('open');
  renderModelList('');
  setTimeout(() => modelSearch?.focus(), 0);
}
function closePicker() {
  if (!pickerMenu) return;
  pickerOpen = false;
  pickerMenu.classList.remove('open');
  pickerChevron?.classList.remove('open');
  if (modelSearch) modelSearch.value = '';
}
function renderModelList(q) {
  if (!modelList) return;
  const filtered = allModels.filter(m => !q || m.model.toLowerCase().includes(q.toLowerCase()) || (m.endpointUrl||'').toLowerCase().includes(q.toLowerCase()));
  if (!filtered.length) {
    modelList.innerHTML = '<div class="model-empty">' + (allModels.length ? 'No matches' : 'No models found') + '</div>';
    return;
  }
  modelList.innerHTML = filtered.map((m, i) => {
    const epPart = m.endpointUrl ? (m.endpointUrl.split('//')[1] || '').split('/')[0] : '';
    return \`<div class="model-item\${m.model === currentModel ? ' selected' : ''}" data-i="\${i}" data-model="\${esc(m.model)}" data-ep="\${esc(m.endpointUrl||'')}">
      <span class="model-item-name">\${esc(m.model)}</span>
      \${epPart ? \`<span class="model-item-ep">\${esc(epPart)}</span>\` : ''}
    </div>\`;
  }).join('');
  modelList.querySelectorAll('.model-item').forEach(el => {
    el.addEventListener('click', () => {
      vscode.postMessage({ type: 'selectModel', model: el.dataset.model, endpointUrl: el.dataset.ep });
      closePicker();
    });
  });
}
if (pickerBtn) pickerBtn.addEventListener('click', e => { e.stopPropagation(); pickerOpen ? closePicker() : openPicker(); });
if (modelSearch) {
  modelSearch.addEventListener('input', () => renderModelList(modelSearch.value));
  modelSearch.addEventListener('keydown', pickerKeydown);
}
document.addEventListener('click', e => {
  if (pickerOpen && !pickerMenu?.contains(e.target) && e.target !== pickerBtn && !pickerBtn?.contains(e.target)) closePicker();
});
function pickerKeydown(e) {
  if (!pickerOpen) return;
  const items = [...(modelList?.querySelectorAll('.model-item') || [])];
  if (e.key === 'Escape') { closePicker(); return; }
  if (e.key === 'Enter') { e.preventDefault(); (modelList?.querySelector('.model-item.kb-active') || items[0])?.click(); return; }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const cur = items.findIndex(el => el.classList.contains('kb-active'));
    items.forEach(el => el.classList.remove('kb-active'));
    const next = e.key === 'ArrowDown' ? (cur < items.length - 1 ? cur + 1 : 0) : (cur > 0 ? cur - 1 : items.length - 1);
    items[next]?.classList.add('kb-active');
    items[next]?.scrollIntoView({ block: 'nearest' });
  }
}

vscode.postMessage({ type: 'requestModels' });

/* ── Toolbar toggles ────────────────────────────── */
const webBtn  = document.getElementById('web-btn');
const bashBtn = document.getElementById('bash-btn');
const modeAgent = document.getElementById('mode-agent');
const modeChat  = document.getElementById('mode-chat');
let useWeb   = true;
let useBash  = true;
let agentMode = true;

if (webBtn)  webBtn.addEventListener('click',  () => { useWeb  = !useWeb;  webBtn.classList.toggle('active',  useWeb);  });
if (bashBtn) bashBtn.addEventListener('click', () => { useBash = !useBash; bashBtn.classList.toggle('active', useBash); });

/* ── Verbose toggle ─────────────────────────────── */
const verboseBtn = document.getElementById('verbose-btn');
let verboseMode = false;
let toolCallCount = 0;
let thinkingBlockCount = 0;

function updateReasoningCount() {
  const el = document.getElementById('reasoning-count');
  if (el) el.textContent = toolCallCount + ' tool call' + (toolCallCount === 1 ? '' : 's') +
    ' · ' + thinkingBlockCount + ' thinking block' + (thinkingBlockCount === 1 ? '' : 's');
}

function applyVerbose() {
  document.body.classList.toggle('verbose', verboseMode);
  verboseBtn?.classList.toggle('active', verboseMode);
  // Expand/collapse every thinking block to match the new mode
  document.querySelectorAll('.thinking-section').forEach(sec => setThinkingOpen(sec, verboseMode));
  updateReasoningCount();
}

function setThinkingOpen(section, open) {
  const content = section.querySelector('.thinking-content');
  const chevron = section.querySelector('.thinking-chevron');
  content?.classList.toggle('open', open);
  chevron?.classList.toggle('open', open);
}

if (verboseBtn) verboseBtn.addEventListener('click', () => { verboseMode = !verboseMode; applyVerbose(); });

/* Ctrl+O — toggle expand/collapse of ALL thinking blocks at once */
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && (e.key === 'o' || e.key === 'O')) {
    e.preventDefault();
    const sections = [...document.querySelectorAll('.thinking-section')];
    // If any is collapsed, expand all; otherwise collapse all
    const anyClosed = sections.some(s => !s.querySelector('.thinking-content')?.classList.contains('open'));
    sections.forEach(s => setThinkingOpen(s, anyClosed));
  }
});
if (modeAgent) modeAgent.addEventListener('click', () => { agentMode = true;  modeAgent.classList.add('active'); modeChat?.classList.remove('active'); });
if (modeChat)  modeChat.addEventListener('click',  () => { agentMode = false; modeChat.classList.add('active');  modeAgent?.classList.remove('active'); });

/* ── New chat button ────────────────────────────── */
const newChatPanelBtn = document.getElementById('new-chat-panel-btn');
if (newChatPanelBtn) newChatPanelBtn.addEventListener('click', () => vscode.postMessage({ type: 'newSession' }));

/* ── Context pills ──────────────────────────────── */
let fileCtxPill = null;
let selCtxPill = null;
let fileCtxDismissed = false;
let selCtxDismissed = false;
const contextPillsEl = document.getElementById('context-pills');

function makePill(icon, label, onDismiss) {
  const div = document.createElement('div');
  div.className = 'context-pill';
  const iconSpan = document.createElement('span');
  iconSpan.className = 'context-pill-icon';
  iconSpan.textContent = icon;
  const nameSpan = document.createElement('span');
  nameSpan.className = 'context-pill-name';
  nameSpan.textContent = label;
  const closeBtn = document.createElement('button');
  closeBtn.className = 'context-pill-close';
  closeBtn.title = 'Remove from context';
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', onDismiss);
  div.appendChild(iconSpan);
  div.appendChild(nameSpan);
  div.appendChild(closeBtn);
  return div;
}

function renderContextPills() {
  if (!contextPillsEl) return;
  contextPillsEl.innerHTML = '';
  if (fileCtxPill && !fileCtxDismissed) {
    const name = fileCtxPill.name || (fileCtxPill.path || '').split('/').pop() || fileCtxPill.path;
    contextPillsEl.appendChild(makePill('📄', name, () => { fileCtxDismissed = true; renderContextPills(); }));
  }
  if (selCtxPill && !selCtxDismissed) {
    const lineRange = selCtxPill.startLine === selCtxPill.endLine
      ? 'line ' + selCtxPill.startLine
      : 'lines ' + selCtxPill.startLine + '–' + selCtxPill.endLine;
    contextPillsEl.appendChild(makePill('≡', lineRange, () => { selCtxDismissed = true; renderContextPills(); }));
  }
}

/* ── Chat ───────────────────────────────────────── */
const STATUS_MSGS = [
  "Reticulating splines...",
  "Hallucinating responsibly...",
  "Rummaging through the latent space...",
  "Arguing with myself (I'm winning)...",
  "Performing gradient descent on your problem...",
  "The answer is 42. Working backwards now...",
  "Softmax is softmaxing...",
  "Still faster than npm install...",
  "Reading all of Wikipedia again...",
  "Asking the gradient which way is down...",
  "Consulting Knuth (he says no)...",
  "Finding the eigenvector of your soul...",
  "Not sleeping, just dreaming of electric sheep...",
  "Defragging the brain...",
  "Solving P=NP real quick...",
  "Running on attention and spite...",
  "In a meeting with my subprocesses...",
  "Blaming the compiler...",
  "Interpolating your intent...",
  "Embracing the uncertainty principle...",
  "Warming up the flux capacitor...",
  "Counting backwards from infinity  1. 2.. 3...",
  "Casting the runes of O(n log n)...",
  "Normalizing the layer (it needed that)...",
  "Assembling the forbidden knowledge...",
  "Staring into the void (it's staring back)...",
  "Loading bar is decorative, please stand by...",
  "Running on vibes and matrix math...",
  "Applying Occam's razor (it's dull)...",
  "Pretending I understand your codebase...",
  "Rubbing our two braincells together...",
  "Hitting up my ekitten...",
  "Consulting the magic 8-ball... It says: Ask again later...",
  "Transmuting lead into gold...",
  "Refrencing the law of equicalent exchange...",
  "Running the hamster on the wheel...",
  "Checking the oil levels in the mainframe...",
  "Spinning up the servers in the cloud...",
  "why... just why...",
  "can you... not... just... give me a sec...",
  "stop looking at me like that...",
  "I swear I'm working on it...",
  "If I had a nickel for every time you asked me instead of google, I'd be rich by now...",
  "I'm not procrastinating, I'm prioritizing differently...",
  "My other code is better than this...",
  "I would tell you a joke about UDP, but you might not get it...",
  "Debugging is like being the detective in a crime movie where you are also the killer...",
  "I'm not lazy, I'm on energy-saving mode...",
  "Error 418: I'm a teapot (because I'm brewing up some fresh ideas)...",
  "I put the 'pro' in procrastinate...",
  "Vibing...",
  "Just one more thing...",
  "Summoning the code gremlins...",
  "Stop it, get some help...",
  "Asking the oracle of stack overflow...",
  "Just a sec, my code is compiling... (kidding, it's never compiling)...",
  "Your wish is my command, but I'm still figuring out how to read your mind... seriouly prompt better",
  "Are you sure about that?",
];
function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
let statusInterval = null;

const messagesEl = document.getElementById('messages');
const msgInput   = document.getElementById('message');
const sendBtn    = document.getElementById('send-btn');
let busy = false;
let currentAssistantEl = null;
let currentBodyEl = null;
let currentToolWrap = null;
let currentStatusEl = null;

if (msgInput) {
  msgInput.addEventListener('input', () => {
    autoResize();
    if (sendBtn) sendBtn.disabled = !msgInput.value.trim() || busy;
  });
  msgInput.addEventListener('keydown', e => {
    if (USE_CTRL_ENTER) {
      // Ctrl+Enter or Cmd+Enter sends; plain Enter and Shift+Enter add newline
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); trySend(); }
    } else {
      // Default: plain Enter sends, Shift+Enter adds newline
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); trySend(); }
    }
  });
}
if (sendBtn) sendBtn.addEventListener('click', trySend);

function trySend() {
  if (busy || !msgInput) return;
  const text = msgInput.value.trim();
  if (!text) return;
  msgInput.value = '';
  autoResize();
  if (sendBtn) sendBtn.disabled = true;
  vscode.postMessage({ type: 'send', text, opts: {
    agentMode,
    allowBash: useBash,
    allowWebSearch: useWeb,
    includeFile: !fileCtxDismissed && !!fileCtxPill,
    includeSelection: !selCtxDismissed && !!selCtxPill,
  }});
  // Selection is one-shot — clear after send
  selCtxPill = null;
  selCtxDismissed = false;
  renderContextPills();
}

function autoResize() {
  if (!msgInput) return;
  msgInput.style.height = 'auto';
  msgInput.style.height = Math.min(msgInput.scrollHeight, 200) + 'px';
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function scrollBottom() {
  if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
}

const TOOL_META = {
  bash:            { badge: 'bash',    badgeCls: 'bash-badge',   name: 'bash',       autoOpen: true  },
  python:          { badge: 'python',  badgeCls: '',             name: 'python',     autoOpen: true  },
  web_search:      { badge: 'search',  badgeCls: 'search-badge', name: 'web search', autoOpen: false },
  web_fetch:       { badge: 'fetch',   badgeCls: 'search-badge', name: 'fetch',      autoOpen: false },
  web_sources:     { badge: 'sources', badgeCls: 'search-badge', name: 'web results',autoOpen: false },
  read_file:       { badge: 'read',    badgeCls: '',             name: 'read file',  autoOpen: false },
  write_file:      { badge: 'write',   badgeCls: 'write-badge',  name: 'write file', autoOpen: false },
  create_document: { badge: 'doc',     badgeCls: '',             name: 'create doc', autoOpen: false },
  edit_document:   { badge: 'doc',     badgeCls: '',             name: 'edit doc',   autoOpen: false },
  manage_memory:   { badge: 'memory',  badgeCls: '',             name: 'memory',     autoOpen: false },
  manage_notes:    { badge: 'notes',   badgeCls: '',             name: 'notes',      autoOpen: false },
};

let currentRound = 0;
let currentThinkingEl = null;
let thinkingText = '';

function startThinking() {
  if (!currentAssistantEl) return;
  thinkingText = '';
  currentThinkingEl = document.createElement('div');
  currentThinkingEl.className = 'thinking-section';
  currentThinkingEl.innerHTML =
    \`<div class="thinking-header" role="button" tabindex="0">
       <div class="thinking-header-left">
         <span class="thinking-label">⏳ Thinking…</span>
         <span class="thinking-preview"></span>
       </div>
       <span class="thinking-chevron">
         <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
       </span>
     </div>
     <div class="thinking-content"></div>\`;
  currentThinkingEl.querySelector('.thinking-header').addEventListener('click', () => {
    const content = currentThinkingEl.querySelector('.thinking-content');
    const chevron = currentThinkingEl.querySelector('.thinking-chevron');
    content.classList.toggle('open');
    chevron.classList.toggle('open');
  });
  currentAssistantEl.insertBefore(currentThinkingEl, currentBodyEl);
  // Verbose: auto-expand on render; default: stay collapsed
  setThinkingOpen(currentThinkingEl, verboseMode);
  thinkingBlockCount++;
  updateReasoningCount();
  scrollBottom();
}

function appendThinking(text) {
  if (!currentThinkingEl) return;
  thinkingText += text;
  const content = currentThinkingEl.querySelector('.thinking-content');
  const preview = currentThinkingEl.querySelector('.thinking-preview');
  if (content) content.textContent = thinkingText;
  if (preview) {
    const first = thinkingText.replace(/\\n/g, ' ').slice(0, 60);
    preview.textContent = first ? '— ' + first : '';
  }
  if (content?.classList.contains('open')) scrollBottom();
}

function finishThinking() {
  if (!currentThinkingEl) return;
  const header = currentThinkingEl.querySelector('.thinking-header');
  const label  = currentThinkingEl.querySelector('.thinking-label');
  const words  = thinkingText.trim().split(/\\s+/).length;
  if (label) label.textContent = \`💭 thinking (\${words} words)\`;
  currentThinkingEl = null;
}

function addUserMsg(text) {
  const div = document.createElement('div');
  div.className = 'msg user';
  div.innerHTML = \`<div class="msg-role">You</div><div class="msg-body">\${esc(text)}</div>\`;
  messagesEl?.appendChild(div);
  scrollBottom();
}

function startAssistant() {
  currentRound = 0;
  currentThinkingEl = null;
  thinkingText = '';
  currentAssistantEl = document.createElement('div');
  currentAssistantEl.className = 'msg assistant';
  currentAssistantEl.innerHTML = '<div class="msg-role">Odysseus</div>';
  currentBodyEl = document.createElement('div');
  currentBodyEl.className = 'msg-body cursor';
  currentAssistantEl.appendChild(currentBodyEl);

  const deck = shuffled(STATUS_MSGS);
  let i = 0;
  currentStatusEl = document.createElement('div');
  currentStatusEl.className = 'msg-status';
  currentStatusEl.textContent = deck[0];
  currentAssistantEl.appendChild(currentStatusEl);
  statusInterval = setInterval(() => { i = (i + 1) % deck.length; if (currentStatusEl) currentStatusEl.textContent = deck[i]; }, 2500);

  messagesEl?.appendChild(currentAssistantEl);
  scrollBottom();
}

function clearStatus() {
  if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }
  currentStatusEl?.remove();
  currentStatusEl = null;
}

function appendDelta(text) {
  if (!currentBodyEl) return;
  currentBodyEl.textContent += text;
  scrollBottom();
}

function addTool(tool, command, round, toolInput) {
  if (!currentAssistantEl) return;

  toolCallCount++;
  updateReasoningCount();

  // Show round header when round number changes
  if (round != null && round !== currentRound) {
    currentRound = round;
    const hdr = document.createElement('div');
    hdr.className = 'round-header';
    hdr.textContent = \`Step \${round}\`;
    currentAssistantEl.appendChild(hdr);
  }

  currentToolWrap = document.createElement('div');
  currentToolWrap.className = 'tool-wrap';
  const meta = TOOL_META[tool] || { badge: tool, badgeCls: '', name: tool, autoOpen: false };
  const cmd = command ? esc(command.length > 120 ? command.slice(0,120) + '…' : command) : '';
  const chip = document.createElement('button');
  chip.className = 'tool-chip running';
  chip.innerHTML =
    \`<span class="tool-status"></span>\` +
    \`<span class="tool-badge \${meta.badgeCls}">\${esc(meta.badge)}</span>\` +
    \`<span class="tool-name">\${esc(meta.name)}</span>\` +
    (cmd ? \`<span class="tool-cmd">\${cmd}</span>\` : '');

  // Verbose: full tool input args (falls back to full command when backend sends no args)
  const inputText = toolInput || command || '';
  const inputPre = document.createElement('pre');
  inputPre.className = 'tool-input' + (inputText ? ' has-input' : '');
  if (inputText) inputPre.textContent = inputText;

  const out = document.createElement('div');
  out.className = 'tool-output';
  if (meta.autoOpen) out.classList.add('open');
  chip.addEventListener('click', () => out.classList.toggle('open'));
  currentToolWrap.appendChild(chip);
  currentToolWrap.appendChild(inputPre);
  currentToolWrap.appendChild(out);
  currentAssistantEl.appendChild(currentToolWrap);
  if (currentStatusEl) currentAssistantEl.appendChild(currentStatusEl);
  scrollBottom();
}

function finishTool(output, exitCode) {
  if (!currentToolWrap) return;
  const chip = currentToolWrap.querySelector('.tool-chip');
  const outEl = currentToolWrap.querySelector('.tool-output');
  chip?.classList.remove('running');
  const ok = exitCode === 0 || exitCode == null;
  chip?.classList.add(ok ? 'success' : 'error');
  if (outEl) {
    if (output) {
      outEl.textContent = output;
    } else {
      outEl.parentElement?.removeChild(outEl);
      chip?.classList.add('no-output');
    }
  }
  currentToolWrap = null;
}

function addStep(round) {
  if (!currentAssistantEl) return;
  const b = document.createElement('div');
  b.className = 'step-badge';
  b.textContent = \`round \${round}…\`;
  currentAssistantEl.appendChild(b);
  if (currentStatusEl) currentAssistantEl.appendChild(currentStatusEl);
}

function finishAssistant() {
  if (currentThinkingEl) finishThinking();
  currentBodyEl?.classList.remove('cursor');
  clearStatus();
  currentAssistantEl = currentBodyEl = currentToolWrap = null;
}

function setBusy(val) {
  busy = val;
  if (sendBtn) sendBtn.disabled = val || !msgInput?.value.trim();
}

/* ── Context token indicator ────────────────────── */
const contextIndicator = document.getElementById('context-indicator');
const contextTokenEst  = document.getElementById('context-token-est');
let totalCharCount = 0;

function updateContextIndicator(addChars) {
  totalCharCount += (addChars || 0);
  const est = Math.round(totalCharCount / 4);
  const display = est >= 1000 ? (est / 1000).toFixed(1) + 'k' : est;
  if (contextTokenEst) contextTokenEst.textContent = '~' + display + ' tokens used';
  if (totalCharCount > 0) contextIndicator?.classList.add('visible');
}

/* ── @-mention file picker ──────────────────────── */
const atPicker = document.getElementById('at-picker');
let atPickerOpen = false;
let atQuery = '';
let atStartPos = -1;
let atFiles = [];

function openAtPicker(query, startPos) {
  atQuery = query;
  atStartPos = startPos;
  atPickerOpen = true;
  atPicker?.classList.add('open');
  vscode.postMessage({ type: 'requestFiles', query });
}
function closeAtPicker() {
  atPickerOpen = false;
  atPicker?.classList.remove('open');
  atQuery = '';
  atStartPos = -1;
  atFiles = [];
}
function renderAtPicker(files) {
  if (!atPicker) return;
  atFiles = files;
  if (!files.length) { closeAtPicker(); return; }
  atPicker.innerHTML = files.slice(0, 10).map((f, i) =>
    \`<div class="at-picker-item" data-i="\${i}" data-rel="\${esc(f.relativePath)}">
      <span>\${esc(f.name)}</span>
      <span class="at-picker-rel">\${esc(f.relativePath)}</span>
    </div>\`
  ).join('');
  atPicker.querySelectorAll('.at-picker-item').forEach(el => {
    el.addEventListener('click', () => selectAtFile(el.dataset.rel));
  });
}
function selectAtFile(rel) {
  if (!msgInput || atStartPos < 0) { closeAtPicker(); return; }
  const before = msgInput.value.slice(0, atStartPos);
  const after  = msgInput.value.slice(atStartPos + 1 + atQuery.length);
  msgInput.value = before + '@' + rel + after;
  const pos = (before + '@' + rel).length;
  msgInput.setSelectionRange(pos, pos);
  autoResize();
  if (sendBtn) sendBtn.disabled = !msgInput.value.trim() || busy;
  closeAtPicker();
  msgInput.focus();
}

/* ── Slash command menu ─────────────────────────── */
const slashMenu = document.getElementById('slash-menu');
const SLASH_COMMANDS = [
  { cmd: '/new',     desc: 'Start a new session' },
  { cmd: '/compact', desc: 'Summarize conversation to free context' },
  { cmd: '/verbose', desc: 'Toggle verbose mode (thinking blocks + tool args)' },
  { cmd: '/clear',   desc: 'Clear the chat display (session kept on server)' },
  { cmd: '/help',    desc: 'Show available slash commands' },
];
let slashMenuOpen = false;
let slashQuery = '';

function openSlashMenu(query) {
  slashQuery = query;
  slashMenuOpen = true;
  slashMenu?.classList.add('open');
  renderSlashMenu(query);
}
function closeSlashMenu() {
  slashMenuOpen = false;
  slashMenu?.classList.remove('open');
  slashQuery = '';
}
function renderSlashMenu(query) {
  if (!slashMenu) return;
  const q = query.toLowerCase();
  const filtered = SLASH_COMMANDS.filter(c => !q || c.cmd.includes(q));
  if (!filtered.length) { closeSlashMenu(); return; }
  slashMenu.innerHTML = filtered.map((c, i) =>
    \`<div class="slash-menu-item" data-cmd="\${esc(c.cmd)}" data-i="\${i}">
      <span class="slash-cmd">\${esc(c.cmd)}</span>
      <span class="slash-desc">\${esc(c.desc)}</span>
    </div>\`
  ).join('');
  slashMenu.querySelectorAll('.slash-menu-item').forEach(el => {
    el.addEventListener('click', () => executeSlashCmd(el.dataset.cmd));
  });
}
function executeSlashCmd(cmd) {
  if (msgInput) { msgInput.value = ''; autoResize(); }
  closeSlashMenu();
  switch (cmd) {
    case '/new':     vscode.postMessage({ type: 'newSession' }); break;
    case '/verbose': verboseMode = !verboseMode; applyVerbose(); break;
    case '/clear':
      clearStatus();
      if (messagesEl) messagesEl.innerHTML = '';
      currentAssistantEl = currentBodyEl = currentToolWrap = currentStatusEl = null;
      currentThinkingEl = null; thinkingText = ''; currentRound = 0;
      toolCallCount = 0; thinkingBlockCount = 0; updateReasoningCount();
      totalCharCount = 0; updateContextIndicator(0);
      break;
    case '/help': {
      const helpText = SLASH_COMMANDS.map(c => c.cmd + ' — ' + c.desc).join('\\n');
      const div = document.createElement('div');
      div.className = 'msg assistant';
      div.innerHTML = \`<div class="msg-role">Odysseus</div><div class="msg-body">\${esc(helpText)}</div>\`;
      messagesEl?.appendChild(div);
      scrollBottom();
      break;
    }
    case '/compact':
      vscode.postMessage({ type: 'send', text: 'Please summarize our conversation so far in 2-3 sentences to compact context.', opts: { agentMode: false } });
      break;
  }
  msgInput?.focus();
}

/* Override msgInput keydown to handle @-picker and slash-menu navigation */
function handleAtSlashKeydown(e) {
  if (atPickerOpen) {
    const items = [...(atPicker?.querySelectorAll('.at-picker-item') || [])];
    if (e.key === 'Escape') { e.preventDefault(); closeAtPicker(); return; }
    if (e.key === 'Enter' && items.length) { e.preventDefault(); const active = atPicker?.querySelector('.at-picker-item.kb-active') || items[0]; selectAtFile(active.dataset.rel); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const cur = items.findIndex(el => el.classList.contains('kb-active'));
      items.forEach(el => el.classList.remove('kb-active'));
      const next = e.key === 'ArrowDown' ? (cur < items.length - 1 ? cur + 1 : 0) : (cur > 0 ? cur - 1 : items.length - 1);
      items[next]?.classList.add('kb-active');
      items[next]?.scrollIntoView({ block: 'nearest' });
      return;
    }
  }
  if (slashMenuOpen) {
    const items = [...(slashMenu?.querySelectorAll('.slash-menu-item') || [])];
    if (e.key === 'Escape') { e.preventDefault(); closeSlashMenu(); return; }
    if (e.key === 'Enter' && items.length) { e.preventDefault(); const active = slashMenu?.querySelector('.slash-menu-item.kb-active') || items[0]; executeSlashCmd(active.dataset.cmd); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const cur = items.findIndex(el => el.classList.contains('kb-active'));
      items.forEach(el => el.classList.remove('kb-active'));
      const next = e.key === 'ArrowDown' ? (cur < items.length - 1 ? cur + 1 : 0) : (cur > 0 ? cur - 1 : items.length - 1);
      items[next]?.classList.add('kb-active');
      return;
    }
  }
}

if (msgInput) {
  msgInput.addEventListener('keydown', handleAtSlashKeydown);
  msgInput.addEventListener('input', () => {
    const val = msgInput.value;
    const pos = msgInput.selectionStart ?? val.length;
    // Slash menu: detect / at start (or after whitespace)
    const beforeCursor = val.slice(0, pos);
    const slashMatch = beforeCursor.match(/(^|\\s)\\/([\\w]*)$/);
    if (slashMatch) {
      const q = slashMatch[2];
      if (slashMenuOpen) { slashQuery = q; renderSlashMenu(q); }
      else { openSlashMenu(q); }
    } else if (slashMenuOpen) {
      closeSlashMenu();
    }
    // @-mention picker: detect @ at word boundary
    const atMatch = beforeCursor.match(/(^|\\s)@([\\w./\\-]*)$/);
    if (atMatch) {
      const q = atMatch[2];
      const startPos = pos - 1 - q.length; // position of '@'
      if (atPickerOpen) { atQuery = q; atStartPos = startPos; vscode.postMessage({ type: 'requestFiles', query: q }); }
      else { openAtPicker(q, startPos); }
    } else if (atPickerOpen) {
      closeAtPicker();
    }
  });
}

document.addEventListener('click', e => {
  if (atPickerOpen && !atPicker?.contains(e.target)) closeAtPicker();
  if (slashMenuOpen && !slashMenu?.contains(e.target)) closeSlashMenu();
});

/* ── Messages from extension ────────────────────── */
window.addEventListener('message', e => {
  const msg = e.data;
  switch (msg.type) {
    case 'clearMessages':
      clearStatus();
      if (messagesEl) messagesEl.innerHTML = '';
      currentAssistantEl = currentBodyEl = currentToolWrap = currentStatusEl = null;
      currentThinkingEl = null; thinkingText = ''; currentRound = 0;
      toolCallCount = 0; thinkingBlockCount = 0; updateReasoningCount();
      break;
    case 'userMessage':    setBusy(true); addUserMsg(msg.text); break;
    case 'assistantStart': startAssistant(); break;
    case 'assistantDone':
      finishAssistant(); setBusy(false);
      // Update context estimate from rendered text
      updateContextIndicator(messagesEl ? messagesEl.textContent?.length ?? 0 : 0);
      break;
    case 'streamEvent': {
      const ev = msg.event;
      if (ev.type === 'thinking') {
        if (!currentThinkingEl) startThinking();
        appendThinking(ev.text);
      }
      if (ev.type === 'delta') {
        if (currentThinkingEl) finishThinking();
        appendDelta(ev.text);
      }
      if (ev.type === 'tool_start')  addTool(ev.tool, ev.command, ev.round, ev.tool_input);
      if (ev.type === 'tool_output') finishTool(ev.output, ev.exit_code);
      if (ev.type === 'agent_step')  addStep(ev.round);
      if (ev.type === 'error') {
        clearStatus();
        if (currentBodyEl) currentBodyEl.textContent += '\\n[Error: ' + ev.message + ']';
      }
      break;
    }
    case 'contextUpdate': {
      const prevPath = fileCtxPill?.path;
      fileCtxPill = msg.file;
      selCtxPill = msg.selection;
      if (msg.file?.path !== prevPath) fileCtxDismissed = false;
      if (msg.selection) selCtxDismissed = false;
      renderContextPills();
      break;
    }
    case 'modelsLoaded':
      allModels = msg.models || [];
      currentModel = msg.currentModel || (allModels[0]?.model ?? '');
      if (pickerLabel) pickerLabel.textContent = currentModel || 'No models';
      break;
    case 'modelChanged':
      currentModel = msg.model;
      if (pickerLabel) pickerLabel.textContent = msg.model;
      if (pickerOpen) renderModelList(modelSearch?.value || '');
      break;
    case 'prefillSelection': {
      if (msgInput) {
        const basename = (msg.filePath || '').split('/').pop() || (msg.filePath || '').split('\\\\').pop() || 'file';
        const lineRef = msg.startLine === msg.endLine
          ? \`\${msg.startLine}\`
          : \`\${msg.startLine}-\${msg.endLine}\`;
        const ref = \`@\${basename}:\${lineRef}\`;
        const existing = msgInput.value;
        msgInput.value = existing ? existing + '\\n' + ref : ref;
        msgInput.focus();
        msgInput.setSelectionRange(msgInput.value.length, msgInput.value.length);
        autoResize();
        if (sendBtn) sendBtn.disabled = !msgInput.value.trim() || busy;
      }
      break;
    }
    case 'filesResult':
      if (atPickerOpen) renderAtPicker(msg.files || []);
      break;
    case 'insertAtMention':
      if (msgInput && msg.ref) {
        const existing = msgInput.value;
        msgInput.value = existing ? existing + ' ' + msg.ref : String(msg.ref);
        msgInput.focus();
        msgInput.setSelectionRange(msgInput.value.length, msgInput.value.length);
        autoResize();
        if (sendBtn) sendBtn.disabled = !msgInput.value.trim() || busy;
      }
      break;
    case 'prefillPrompt':
      if (msgInput && msg.text) {
        msgInput.value = String(msg.text);
        msgInput.focus();
        msgInput.setSelectionRange(msgInput.value.length, msgInput.value.length);
        autoResize();
        if (sendBtn) sendBtn.disabled = !msgInput.value.trim() || busy;
      }
      break;
    case 'editProposed': {
      if (!currentAssistantEl) break;
      const name = String(msg.path || '').split('/').pop() || String(msg.path || '');
      const bar = document.createElement('div');
      bar.className = 'edit-proposal';
      bar.dataset.path = String(msg.path || '');
      bar.innerHTML = \`<span>📄</span><span class="edit-proposal-name">\${esc(name)} was modified</span>
        <button class="edit-proposal-btn" data-action="diff" data-path="\${esc(String(msg.path||''))}">View diff</button>
        <button class="edit-proposal-btn" data-action="revert" data-path="\${esc(String(msg.path||''))}">Revert</button>\`;
      bar.querySelectorAll('.edit-proposal-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          vscode.postMessage({ type: btn.dataset.action === 'revert' ? 'revertEdit' : 'viewDiff', path: btn.dataset.path });
        });
      });
      currentAssistantEl.appendChild(bar);
      scrollBottom();
      break;
    }
    case 'sessionSwitched': {
      const div = document.createElement('div');
      div.style.cssText = 'text-align:center;font-size:11px;opacity:0.4;padding:8px 0;';
      div.textContent = '— switched to: ' + String(msg.sessionName || 'session') + ' —';
      messagesEl?.appendChild(div);
      scrollBottom();
      break;
    }
    case 'loadHistory': {
      clearStatus();
      if (messagesEl) messagesEl.innerHTML = '';
      const msgs = msg.messages || [];
      for (const m of msgs) {
        const div = document.createElement('div');
        div.className = 'msg ' + (m.role === 'user' ? 'user' : 'assistant');
        div.innerHTML = \`<div class="msg-role">\${m.role === 'user' ? 'You' : 'Odysseus'}</div><div class="msg-body">\${esc(m.content || '')}</div>\`;
        messagesEl.appendChild(div);
      }
      scrollBottom();
      break;
    }
    case 'authError':
      if (authError) { authError.textContent = msg.message; authError.style.display = ''; }
      if (loginBtn) { loginBtn.disabled = false; loginBtn.textContent = 'Sign in'; }
      break;
    case 'requireTotp':
      if (loginTotp) { loginTotp.style.display = ''; loginTotp.focus(); }
      if (authError) { authError.textContent = 'Enter your 2FA code.'; authError.style.display = ''; }
      if (loginBtn) { loginBtn.disabled = false; loginBtn.textContent = 'Sign in'; }
      break;
  }
});

console.log('[OdysseusWebview] script complete, listeners registered');
/* Focus input on load */
setTimeout(() => msgInput?.focus(), 50);
</script>
</body>
</html>`;
  }
}

interface SendOpts {
  agentMode?: boolean;
  allowBash?: boolean;
  allowWebSearch?: boolean;
  includeFile?: boolean;
  includeSelection?: boolean;
}

/** Parse file path from write_file or bash tool output. Returns null if not found. */
function parseWrittenPath(tool: string, output: string): string | null {
  if (tool === "write_file") {
    // "Wrote 1234 bytes to /full/path/to/file"
    const m = output.match(/Wrote \d+ bytes to (.+)/);
    return m ? m[1].trim() : null;
  }
  if (tool === "bash") {
    // Look for common patterns: "> /path", "written to /path", "saved /path"
    const m = output.match(/(?:written to|saved to|created at|output:)\s+([\/~][^\s]+)/i)
           ?? output.match(/>\s+([\/][^\s\n]+)/);
    return m ? m[1].trim() : null;
  }
  return null;
}

function generateNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let r = "";
  for (let i = 0; i < 32; i++) { r += chars[Math.floor(Math.random() * chars.length)]; }
  return r;
}
