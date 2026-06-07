import * as vscode from "vscode";
import { OdysseusClient } from "./api/client";

type ViewState = "loading" | "disconnected" | "ready";

export class MemoryViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "odysseus.memoryView";

  private view?: vscode.WebviewView;
  private client?: OdysseusClient;
  private state: ViewState = "loading";

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _ctx: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.buildHtml("loading");
    webviewView.webview.onDidReceiveMessage(
      (msg) => this.handleMessage(msg),
      undefined,
      this.context.subscriptions
    );
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible && this.state === "ready") { this.loadMemories(); }
    }, undefined, this.context.subscriptions);
    this.init();
  }

  private getUrl(): string {
    return vscode.workspace
      .getConfiguration("odysseus")
      .get<string>("url", "http://localhost:7860");
  }

  private async init(): Promise<void> {
    this.setState("loading");
    const url = this.getUrl();
    const token = await this.context.secrets.get("odysseus.token");
    this.client = new OdysseusClient(url, token);
    try {
      await this.client.getAuthStatus();
    } catch {
      this.setState("disconnected");
      return;
    }
    this.setState("ready");
    await this.loadMemories();
  }

  private async loadMemories(): Promise<void> {
    if (!this.client) { return; }
    const memories = await this.client.listMemories();
    this.postMessage({ type: "memoriesLoaded", memories });
  }

  private async handleMessage(msg: { type: string; [k: string]: unknown }): Promise<void> {
    switch (msg.type) {
      case "requestMemories":
        await this.loadMemories();
        break;
      case "addMemory": {
        if (!this.client) { break; }
        await this.client.addMemory(String(msg.text ?? ""), String(msg.category ?? "general"));
        await this.loadMemories();
        break;
      }
      case "deleteMemory": {
        if (!this.client) { break; }
        const choice = await vscode.window.showQuickPick(["Yes, delete", "Cancel"], {
          placeHolder: "Delete this memory?",
        });
        if (choice !== "Yes, delete") { break; }
        await this.client.deleteMemory(String(msg.id ?? ""));
        await this.loadMemories();
        break;
      }
      case "retry":
        await this.init();
        break;
    }
  }

  private setState(s: ViewState): void {
    this.state = s;
    if (this.view) { this.view.webview.html = this.buildHtml(s); }
  }

  private postMessage(msg: unknown): void {
    this.view?.webview.postMessage(msg);
  }

  private buildHtml(state: ViewState): string {
    const nonce = generateNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size, 12px);
  color: var(--vscode-foreground);
  background: var(--vscode-sideBar-background);
  height: 100vh;
  display: flex;
  flex-direction: column;
}
.center {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 20px;
  text-align: center;
}
p { font-size: 11px; opacity: 0.65; }
.btn {
  padding: 5px 14px;
  font-size: 11px;
  font-family: inherit;
  cursor: pointer;
  border-radius: 4px;
  border: none;
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}
.btn:hover { background: var(--vscode-button-hoverBackground); }
.spinner {
  width: 14px; height: 14px;
  border: 2px solid var(--vscode-foreground);
  border-top-color: transparent;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  opacity: 0.4;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* ── Ready layout ───────────────────────────────── */
.main-view { display: flex; flex-direction: column; height: 100vh; }
.add-section {
  padding: 8px 8px 6px;
  display: flex;
  flex-direction: column;
  gap: 5px;
  border-bottom: 1px solid var(--vscode-editorWidget-border, rgba(255,255,255,0.08));
}
.add-row { display: flex; gap: 5px; }
.add-input {
  flex: 1;
  padding: 5px 8px;
  font-size: 11px;
  font-family: inherit;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, #444);
  border-radius: 4px;
  outline: none;
}
.add-input:focus { border-color: var(--vscode-focusBorder); }
.cat-select {
  padding: 5px 6px;
  font-size: 11px;
  font-family: inherit;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, #444);
  border-radius: 4px;
  outline: none;
  cursor: pointer;
}
.add-btn {
  padding: 5px 10px;
  font-size: 11px;
  font-family: inherit;
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border: none;
  border-radius: 4px;
  cursor: pointer;
  white-space: nowrap;
}
.add-btn:hover { background: var(--vscode-button-hoverBackground); }
.filter-row { display: flex; }
.filter-input {
  flex: 1;
  padding: 5px 8px;
  font-size: 11px;
  font-family: inherit;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, #444);
  border-radius: 4px;
  outline: none;
}
.filter-input:focus { border-color: var(--vscode-focusBorder); }
.memory-list { flex: 1; overflow-y: auto; padding: 4px 6px 10px; }
.memory-empty { padding: 16px 10px; font-size: 11px; opacity: 0.5; text-align: center; }
.memory-item {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 6px 6px;
  border-radius: 5px;
  border-bottom: 1px solid var(--vscode-editorWidget-border, rgba(255,255,255,0.05));
}
.memory-item:hover { background: var(--vscode-list-hoverBackground); }
.memory-body { flex: 1; min-width: 0; }
.memory-text {
  font-size: 11.5px;
  line-height: 1.5;
  word-break: break-word;
}
.memory-meta { display: flex; gap: 6px; margin-top: 2px; align-items: center; }
.cat-badge {
  font-size: 9px;
  padding: 1px 5px;
  border-radius: 3px;
  background: rgba(224,108,117,0.18);
  color: #e06c75;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  font-weight: 600;
}
.memory-ts { font-size: 10px; opacity: 0.4; }
.del-btn {
  font-size: 13px;
  line-height: 1;
  opacity: 0.3;
  cursor: pointer;
  padding: 1px 3px;
  border: none;
  background: none;
  color: inherit;
  flex-shrink: 0;
}
.del-btn:hover { opacity: 1; color: var(--vscode-errorForeground); }
</style>
</head>
<body>

${state === "loading" ? `<div class="center"><div class="spinner"></div><p>Loading memories…</p></div>` : ""}
${state === "disconnected" ? `<div class="center"><p>Odysseus not reachable.</p><button class="btn" id="retry-btn">Retry</button></div>` : ""}

${state === "ready" ? `
<div class="main-view">
  <div class="add-section">
    <div class="add-row">
      <input class="add-input" id="add-text" type="text" placeholder="New memory…" autocomplete="off" spellcheck="false">
      <select class="cat-select" id="add-cat">
        <option value="general">general</option>
        <option value="preference">preference</option>
        <option value="fact">fact</option>
        <option value="code">code</option>
        <option value="task">task</option>
      </select>
      <button class="add-btn" id="add-btn">Save</button>
    </div>
    <div class="filter-row">
      <input class="filter-input" id="filter-input" type="text" placeholder="Filter memories…" autocomplete="off" spellcheck="false">
    </div>
  </div>
  <div class="memory-list" id="memory-list"><div class="memory-empty">Loading…</div></div>
</div>
` : ""}

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();

const retryBtn = document.getElementById('retry-btn');
if (retryBtn) retryBtn.onclick = () => vscode.postMessage({ type: 'retry' });

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmtDate(ts) {
  if (!ts) return '';
  try {
    const d = new Date(ts);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch { return ''; }
}

/* ── Ready state ────────────────────────────────── */
const addText     = document.getElementById('add-text');
const addCat      = document.getElementById('add-cat');
const addBtn      = document.getElementById('add-btn');
const filterInput = document.getElementById('filter-input');
const memoryList  = document.getElementById('memory-list');
let allMemories = [];

if (addBtn) addBtn.addEventListener('click', () => {
  const text = addText?.value.trim();
  if (!text) return;
  const category = addCat?.value || 'general';
  vscode.postMessage({ type: 'addMemory', text, category });
  if (addText) addText.value = '';
});
if (addText) addText.addEventListener('keydown', e => { if (e.key === 'Enter') addBtn?.click(); });
if (filterInput) filterInput.addEventListener('input', () => renderMemories(filterInput.value));

if (memoryList) vscode.postMessage({ type: 'requestMemories' });

function renderMemories(query) {
  if (!memoryList) return;
  const q = (query || '').toLowerCase();
  const filtered = allMemories.filter(m =>
    !q || m.text.toLowerCase().includes(q) || (m.category || '').toLowerCase().includes(q)
  );
  if (!filtered.length) {
    memoryList.innerHTML = '<div class="memory-empty">' + (allMemories.length ? 'No matches' : 'No memories yet') + '</div>';
    return;
  }
  memoryList.innerHTML = filtered.map(m =>
    \`<div class="memory-item" data-id="\${esc(m.id)}">
      <div class="memory-body">
        <div class="memory-text">\${esc(m.text)}</div>
        <div class="memory-meta">
          <span class="cat-badge">\${esc(m.category || 'general')}</span>
          <span class="memory-ts">\${esc(fmtDate(m.timestamp))}</span>
        </div>
      </div>
      <button class="del-btn" data-id="\${esc(m.id)}" title="Delete">×</button>
    </div>\`
  ).join('');
  memoryList.querySelectorAll('.del-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: 'deleteMemory', id: btn.dataset.id });
    });
  });
}

window.addEventListener('message', e => {
  const msg = e.data;
  if (msg.type === 'memoriesLoaded') {
    allMemories = msg.memories || [];
    renderMemories(filterInput ? filterInput.value : '');
  }
});
</script>
</body>
</html>`;
  }
}

function generateNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let r = "";
  for (let i = 0; i < 32; i++) { r += chars[Math.floor(Math.random() * chars.length)]; }
  return r;
}
