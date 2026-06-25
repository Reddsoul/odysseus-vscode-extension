import * as vscode from "vscode";
import {
  listSchedules,
  toggleSchedule,
  removeSchedule,
  getNextRunLabel,
  Schedule,
} from "./scheduler";
import { runHeadlessTask } from "./taskRunner";

export class SchedulerViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "odysseus.schedulerView";
  private view?: vscode.WebviewView;

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _ctx: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.buildHtml();
    webviewView.webview.onDidReceiveMessage(
      (msg) => this.handleMessage(msg),
      undefined,
      this.context.subscriptions
    );
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) { this.sendSchedules(); }
    }, undefined, this.context.subscriptions);
    this.sendSchedules();
  }

  /** Call after any external schedule mutation so the UI stays current. */
  public refresh(): void {
    if (this.view?.visible) { this.sendSchedules(); }
  }

  private sendSchedules(): void {
    const schedules = listSchedules(this.context);
    const items = schedules.map(s => ({
      id: s.id,
      name: s.name,
      cronExpr: s.cronExpr,
      enabled: s.enabled,
      nextRun: getNextRunLabel(s),
      lastRun: s.lastRun ? new Date(s.lastRun).toLocaleString() : null,
    }));
    this.view?.webview.postMessage({ type: "schedulesLoaded", schedules: items });
  }

  private async handleMessage(msg: { type: string; [k: string]: unknown }): Promise<void> {
    switch (msg.type) {
      case "requestSchedules":
        this.sendSchedules();
        break;

      case "toggle": {
        const id = String(msg.id ?? "");
        if (!id) { break; }
        await toggleSchedule(this.context, id);
        this.sendSchedules();
        break;
      }

      case "delete": {
        const id = String(msg.id ?? "");
        const name = String(msg.name ?? "this schedule");
        if (!id) { break; }
        const confirm = await vscode.window.showQuickPick(["Yes, delete", "Cancel"], {
          placeHolder: `Delete "${name}"?`,
        });
        if (confirm === "Yes, delete") {
          await removeSchedule(this.context, id);
          this.sendSchedules();
        }
        break;
      }

      case "run": {
        const id = String(msg.id ?? "");
        const sched = listSchedules(this.context).find(s => s.id === id);
        if (sched) { void runHeadlessTask(this.context, sched.prompt); }
        break;
      }

      case "create":
        await vscode.commands.executeCommand("odysseus.scheduleTask");
        this.sendSchedules();
        break;
    }
  }

  private buildHtml(): string {
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
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
}
.top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 10px 8px;
  gap: 6px;
}
.top-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  opacity: 0.55;
}
.new-btn {
  padding: 4px 10px;
  font-size: 11px;
  font-family: inherit;
  cursor: pointer;
  border-radius: 4px;
  border: none;
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  white-space: nowrap;
}
.new-btn:hover { background: var(--vscode-button-hoverBackground); }
.divider { height: 1px; background: var(--vscode-editorWidget-border, rgba(255,255,255,0.08)); }
.list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 4px 10px;
}
.empty {
  padding: 24px 14px;
  font-size: 11px;
  opacity: 0.45;
  text-align: center;
  line-height: 1.7;
}
.row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 5px;
  cursor: default;
  position: relative;
}
.row:hover { background: var(--vscode-list-hoverBackground); }
.dot {
  margin-top: 3px;
  flex-shrink: 0;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #4caf50;
}
.dot.off { background: var(--vscode-disabledForeground, #666); opacity: 0.5; }
.info { flex: 1; min-width: 0; }
.name {
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.meta {
  font-size: 10px;
  opacity: 0.5;
  margin-top: 1px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.next {
  font-size: 10px;
  opacity: 0.45;
  margin-top: 1px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.actions {
  display: none;
  gap: 2px;
  flex-shrink: 0;
  align-items: center;
}
.row:hover .actions { display: flex; }
.act-btn {
  padding: 2px 5px;
  font-size: 10px;
  font-family: inherit;
  border: none;
  background: transparent;
  color: var(--vscode-foreground);
  cursor: pointer;
  border-radius: 3px;
  opacity: 0.55;
  line-height: 1;
}
.act-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.08)); }
.act-btn.del:hover { opacity: 1; color: var(--vscode-errorForeground); }
</style>
</head>
<body>
<div class="top">
  <span class="top-label">Schedules</span>
  <button class="new-btn" id="new-btn">+ New</button>
</div>
<div class="divider"></div>
<div class="list" id="list">
  <div class="empty">Loading…</div>
</div>

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const listEl = document.getElementById('list');
const newBtn = document.getElementById('new-btn');

newBtn.onclick = () => vscode.postMessage({ type: 'create' });

vscode.postMessage({ type: 'requestSchedules' });

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

window.addEventListener('message', e => {
  const msg = e.data;
  if (msg.type !== 'schedulesLoaded') return;
  const schedules = msg.schedules || [];
  if (!schedules.length) {
    listEl.innerHTML = '<div class="empty">No schedules yet.<br>Click <strong>+ New</strong> to create one.</div>';
    return;
  }
  listEl.innerHTML = schedules.map(s => {
    const offClass = s.enabled ? '' : ' off';
    const toggleLabel = s.enabled ? '⏸' : '▶';
    const toggleTitle = s.enabled ? 'Disable' : 'Enable';
    const metaText = esc(s.cronExpr);
    const nextText = s.enabled ? 'next: ' + esc(s.nextRun) : 'disabled';
    return '<div class="row" data-id="' + esc(s.id) + '">' +
      '<div class="dot' + offClass + '"></div>' +
      '<div class="info">' +
        '<div class="name">' + esc(s.name) + '</div>' +
        '<div class="meta">' + metaText + '</div>' +
        '<div class="next">' + nextText + '</div>' +
      '</div>' +
      '<div class="actions">' +
        '<button class="act-btn toggle-btn" data-id="' + esc(s.id) + '" title="' + toggleTitle + '">' + toggleLabel + '</button>' +
        '<button class="act-btn run-btn" data-id="' + esc(s.id) + '" title="Run now">&#9654;</button>' +
        '<button class="act-btn del act-btn del-btn" data-id="' + esc(s.id) + '" data-name="' + esc(s.name) + '" title="Delete">&#128465;</button>' +
      '</div>' +
    '</div>';
  }).join('');

  listEl.querySelectorAll('.toggle-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      vscode.postMessage({ type: 'toggle', id: btn.dataset.id });
    });
  });
  listEl.querySelectorAll('.run-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      vscode.postMessage({ type: 'run', id: btn.dataset.id });
    });
  });
  listEl.querySelectorAll('.del-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      vscode.postMessage({ type: 'delete', id: btn.dataset.id, name: btn.dataset.name });
    });
  });
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
