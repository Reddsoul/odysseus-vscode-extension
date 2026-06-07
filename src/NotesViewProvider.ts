import * as vscode from "vscode";
import { OdysseusClient, Note } from "./api/client";

type ViewState = "loading" | "disconnected" | "ready";

export class NotesViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "odysseus.notesView";

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
      if (webviewView.visible && this.state === "ready") { this.loadNotes(); }
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
    await this.loadNotes();
  }

  private async loadNotes(): Promise<void> {
    if (!this.client) { return; }
    const notes = await this.client.listNotes();
    this.postMessage({ type: "notesLoaded", notes });
  }

  private async handleMessage(msg: { type: string; [k: string]: unknown }): Promise<void> {
    switch (msg.type) {
      case "requestNotes":
        await this.loadNotes();
        break;
      case "createNote": {
        if (!this.client) { break; }
        const title = await vscode.window.showInputBox({ prompt: "Note title", placeHolder: "Title" });
        if (title === undefined) { break; }
        const noteType = String(msg.noteType ?? "note");
        if (noteType === "todo") {
          await this.client.createNote(title, "", "todo");
        } else {
          const content = await vscode.window.showInputBox({ prompt: "Note content", placeHolder: "Content" });
          if (content === undefined) { break; }
          await this.client.createNote(title, content, "note");
        }
        await this.loadNotes();
        break;
      }
      case "deleteNote": {
        if (!this.client) { break; }
        const choice = await vscode.window.showQuickPick(["Yes, delete", "Cancel"], {
          placeHolder: "Delete this note?",
        });
        if (choice !== "Yes, delete") { break; }
        await this.client.deleteNote(String(msg.id ?? ""));
        await this.loadNotes();
        break;
      }
      case "toggleTodo": {
        if (!this.client) { break; }
        await this.client.toggleTodoItem(String(msg.noteId ?? ""), Number(msg.index));
        await this.loadNotes();
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
.toolbar {
  display: flex;
  gap: 5px;
  padding: 8px 8px 6px;
  border-bottom: 1px solid var(--vscode-editorWidget-border, rgba(255,255,255,0.08));
}
.toolbar-btn {
  flex: 1;
  padding: 5px 8px;
  font-size: 11px;
  font-family: inherit;
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border: none;
  border-radius: 4px;
  cursor: pointer;
}
.toolbar-btn:hover { background: var(--vscode-button-hoverBackground); }
.toolbar-btn.secondary {
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
}
.toolbar-btn.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
.notes-list { flex: 1; overflow-y: auto; padding: 4px 6px 10px; }
.notes-empty { padding: 16px 10px; font-size: 11px; opacity: 0.5; text-align: center; }
.note-card {
  margin-bottom: 6px;
  border: 1px solid var(--vscode-editorWidget-border, rgba(255,255,255,0.08));
  border-radius: 6px;
  background: var(--vscode-editorWidget-background);
  overflow: hidden;
}
.note-card.pinned { border-color: rgba(224,108,117,0.35); }
.note-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  cursor: pointer;
  user-select: none;
}
.note-header:hover { background: var(--vscode-list-hoverBackground); }
.note-pin { font-size: 11px; opacity: 0.6; flex-shrink: 0; }
.note-title { flex: 1; font-size: 12px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.note-type-badge {
  font-size: 9px;
  padding: 1px 4px;
  border-radius: 3px;
  background: rgba(255,255,255,0.08);
  opacity: 0.6;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  flex-shrink: 0;
}
.note-del-btn {
  font-size: 13px;
  line-height: 1;
  opacity: 0.3;
  cursor: pointer;
  padding: 0 3px;
  border: none;
  background: none;
  color: inherit;
  flex-shrink: 0;
}
.note-del-btn:hover { opacity: 1; color: var(--vscode-errorForeground); }
.note-body { display: none; padding: 0 8px 8px; }
.note-body.open { display: block; }
.note-content { font-size: 11.5px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; opacity: 0.85; }
.todo-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 0;
  font-size: 11.5px;
  cursor: pointer;
}
.todo-item:hover { opacity: 0.8; }
.todo-check { font-size: 13px; flex-shrink: 0; }
.todo-text { flex: 1; line-height: 1.4; }
.todo-text.done { text-decoration: line-through; opacity: 0.5; }
</style>
</head>
<body>

${state === "loading" ? `<div class="center"><div class="spinner"></div><p>Loading notes…</p></div>` : ""}
${state === "disconnected" ? `<div class="center"><p>Odysseus not reachable.</p><button class="btn" id="retry-btn">Retry</button></div>` : ""}

${state === "ready" ? `
<div class="main-view">
  <div class="toolbar">
    <button class="toolbar-btn" id="new-note-btn">+ Note</button>
    <button class="toolbar-btn secondary" id="new-todo-btn">☑ Todo</button>
  </div>
  <div class="notes-list" id="notes-list"><div class="notes-empty">Loading…</div></div>
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

const newNoteBtn = document.getElementById('new-note-btn');
const newTodoBtn = document.getElementById('new-todo-btn');
const notesList  = document.getElementById('notes-list');
let allNotes = [];
let expandedIds = new Set();

if (newNoteBtn) newNoteBtn.addEventListener('click', () => vscode.postMessage({ type: 'createNote', noteType: 'note' }));
if (newTodoBtn) newTodoBtn.addEventListener('click', () => vscode.postMessage({ type: 'createNote', noteType: 'todo' }));

if (notesList) vscode.postMessage({ type: 'requestNotes' });

function renderNotes() {
  if (!notesList) return;
  const sorted = allNotes.slice().sort((a, b) => {
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    return 0;
  });
  if (!sorted.length) {
    notesList.innerHTML = '<div class="notes-empty">No notes yet</div>';
    return;
  }
  notesList.innerHTML = '';
  for (const note of sorted) {
    const card = document.createElement('div');
    card.className = 'note-card' + (note.pinned ? ' pinned' : '');
    card.dataset.id = note.id;

    const header = document.createElement('div');
    header.className = 'note-header';
    header.innerHTML =
      (note.pinned ? '<span class="note-pin">📌</span>' : '') +
      \`<span class="note-title">\${esc(note.title || 'Untitled')}</span>\` +
      \`<span class="note-type-badge">\${esc(note.note_type || 'note')}</span>\` +
      \`<button class="note-del-btn" data-id="\${esc(note.id)}" title="Delete">×</button>\`;

    const body = document.createElement('div');
    body.className = 'note-body' + (expandedIds.has(note.id) ? ' open' : '');

    if (note.note_type === 'todo' && Array.isArray(note.items)) {
      for (let i = 0; i < note.items.length; i++) {
        const item = note.items[i];
        const row = document.createElement('div');
        row.className = 'todo-item';
        row.dataset.noteId = note.id;
        row.dataset.index = String(i);
        row.innerHTML =
          \`<span class="todo-check">\${item.done ? '☑' : '☐'}</span>\` +
          \`<span class="todo-text\${item.done ? ' done' : ''}">\${esc(item.text)}</span>\`;
        row.addEventListener('click', () => {
          vscode.postMessage({ type: 'toggleTodo', noteId: row.dataset.noteId, index: parseInt(row.dataset.index) });
        });
        body.appendChild(row);
      }
      if (note.items.length === 0) {
        body.innerHTML = '<div style="font-size:11px;opacity:0.4;padding:4px 0;">No items</div>';
      }
    } else {
      body.innerHTML = \`<div class="note-content">\${esc(note.content || '')}</div>\`;
    }

    header.addEventListener('click', (e) => {
      if ((e.target).closest('.note-del-btn')) return;
      if (expandedIds.has(note.id)) { expandedIds.delete(note.id); }
      else { expandedIds.add(note.id); }
      body.classList.toggle('open', expandedIds.has(note.id));
    });
    header.querySelector('.note-del-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: 'deleteNote', id: note.id });
    });

    card.appendChild(header);
    card.appendChild(body);
    notesList.appendChild(card);
  }
}

window.addEventListener('message', e => {
  const msg = e.data;
  if (msg.type === 'notesLoaded') {
    allNotes = msg.notes || [];
    renderNotes();
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
