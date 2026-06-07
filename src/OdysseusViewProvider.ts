import * as vscode from "vscode";
import { OdysseusClient, AuthStatus } from "./api/client";
import { ChatPanel } from "./ChatPanel";

type SidebarState = "loading" | "disconnected" | "auth" | "ready";

export class OdysseusViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "odysseus.chatView";

  private view?: vscode.WebviewView;
  private client?: OdysseusClient;
  private state: SidebarState = "loading";

  constructor(private readonly context: vscode.ExtensionContext) {
    // When the chat panel closes, refresh the history list.
    ChatPanel.onDidClose = () => this.refreshSessions();
  }

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
      if (webviewView.visible && this.state === "ready") { this.refreshSessions(); }
    }, undefined, this.context.subscriptions);
    this.init();
  }

  /** Re-fetch sessions and push them to the sidebar (when in ready state). */
  private async refreshSessions(): Promise<void> {
    if (this.state !== "ready" || !this.client || !this.view) { return; }
    const sessions = await this.client.listSessions();
    this.postMessage({ type: "sessionsLoaded", sessions });
  }

  async init(): Promise<void> {
    this.setState("loading");
    const url = this.getUrl();
    const token = await this.context.secrets.get("odysseus.token");
    this.client = new OdysseusClient(url, token);

    let status: AuthStatus;
    try {
      status = await this.client.getAuthStatus();
    } catch {
      this.setState("disconnected");
      return;
    }

    if (status.configured && !token) {
      this.setState("auth");
      return;
    }
    // Don't re-validate via status.authenticated — that checks session cookies,
    // always returns false for Bearer token callers. Trust the stored token.

    this.setState("ready");
  }

  private getUrl(): string {
    return vscode.workspace
      .getConfiguration("odysseus")
      .get<string>("url", "http://localhost:7860");
  }

  async configure(): Promise<void> {
    const url = await vscode.window.showInputBox({
      prompt: "Odysseus server URL",
      value: this.getUrl(),
      placeHolder: "http://localhost:7860",
    });
    if (url === undefined) { return; }
    await vscode.workspace.getConfiguration("odysseus")
      .update("url", url.trim(), vscode.ConfigurationTarget.Global);
    await this.context.secrets.delete("odysseus.token");
    await this.init();
  }

  async newSession(): Promise<void> {
    vscode.commands.executeCommand("odysseus.openChat");
  }

  async sendSelection(): Promise<void> {
    vscode.commands.executeCommand("odysseus.openChat");
  }

  private async handleMessage(msg: { type: string; [k: string]: unknown }): Promise<void> {
    switch (msg.type) {
      case "newSession": {
        const existing = ChatPanel.getCurrent();
        const panel = ChatPanel.createOrShow(this.context);
        if (existing) { await panel.newSession(); }
        break;
      }
      case "login":
        await this.handleLogin(
          String(msg.username ?? ""),
          String(msg.password ?? ""),
          String(msg.totp ?? "")
        );
        break;
      case "setUrl":
        await this.handleSetUrl(String(msg.url ?? ""));
        break;
      case "retry":
        await this.init();
        break;
      case "requestSessions":
        await this.refreshSessions();
        break;
      case "openSession": {
        const id = String(msg.sessionId ?? "");
        if (id) { ChatPanel.createOrShow(this.context, id); }
        break;
      }
      case "configure":
        await this.configure();
        break;
      case "signOut":
        await this.signOut();
        break;
      case "renameSession": {
        const id = String(msg.sessionId ?? "");
        if (!id || !this.client) { break; }
        const name = await vscode.window.showInputBox({ prompt: "New session name", placeHolder: "Session name" });
        if (name === undefined || !name.trim()) { break; }
        await this.client.renameSession(id, name.trim());
        await this.refreshSessions();
        break;
      }
      case "deleteSession": {
        const id = String(msg.sessionId ?? "");
        if (!id || !this.client) { break; }
        const choice = await vscode.window.showQuickPick(["Yes, delete", "Cancel"], {
          placeHolder: "Delete this session?",
        });
        if (choice !== "Yes, delete") { break; }
        await this.client.deleteSession(id);
        await this.refreshSessions();
        break;
      }
    }
  }

  private async signOut(): Promise<void> {
    try { await this.client?.logout(); } catch { /* ignore */ }
    await this.context.secrets.delete("odysseus.token");
    this.client = new OdysseusClient(this.getUrl());
    // Back to the sign-in screen (server is still configured, just no token).
    this.setState("auth");
  }

  private async handleSetUrl(url: string): Promise<void> {
    const trimmed = url.trim();
    if (!trimmed) { return; }
    await vscode.workspace.getConfiguration("odysseus")
      .update("url", trimmed, vscode.ConfigurationTarget.Global);
    await this.init();
  }

  private async handleLogin(username: string, password: string, totp: string): Promise<void> {
    if (!this.client) { this.client = new OdysseusClient(this.getUrl()); }
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
    this.client = new OdysseusClient(this.getUrl(), result.token);
    this.setState("ready");
    // Open the chat panel now that we're authenticated.
    ChatPanel.createOrShow(this.context);
  }

  private setState(s: SidebarState): void {
    this.state = s;
    if (this.view) {
      this.view.webview.html = this.buildHtml(s);
    }
  }

  private postMessage(msg: unknown): void {
    this.view?.webview.postMessage(msg);
  }

  private buildHtml(state: SidebarState): string {
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
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 20px;
  text-align: center;
}
h2 { font-size: 13px; font-weight: 600; }
p  { font-size: 11px; opacity: 0.65; line-height: 1.5; }
.btn {
  display: inline-block;
  padding: 6px 16px;
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  border-radius: 5px;
  border: none;
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  width: 100%;
  max-width: 180px;
}
.btn:hover { background: var(--vscode-button-hoverBackground); }
.btn.secondary {
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  margin-top: 4px;
}
.btn.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
.url-input {
  width: 100%;
  max-width: 220px;
  padding: 4px 8px;
  font-size: 11px;
  font-family: inherit;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, #555);
  border-radius: 3px;
  outline: none;
}
.url-input:focus { border-color: var(--vscode-focusBorder); }
.error-msg { color: var(--vscode-errorForeground); font-size: 11px; }
.spinner {
  width: 14px; height: 14px;
  border: 2px solid var(--vscode-foreground);
  border-top-color: transparent;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  opacity: 0.4;
}
@keyframes spin { to { transform: rotate(360deg); } }
.status-dot {
  width: 8px; height: 8px;
  border-radius: 50%;
  background: #4caf50;
  display: inline-block;
  margin-right: 5px;
}

/* ── History sidebar (ready state) ──────────────── */
body.ready {
  align-items: stretch;
  justify-content: flex-start;
  padding: 0;
  text-align: left;
}
.ready-view {
  display: flex;
  flex-direction: column;
  height: 100vh;
  width: 100%;
}
.ready-top { padding: 10px 10px 8px; display: flex; flex-direction: column; gap: 8px; }
.new-chat-btn {
  width: 100%;
  padding: 7px 12px;
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  border: none;
  border-radius: 6px;
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  text-align: center;
}
.new-chat-btn:hover { background: var(--vscode-button-hoverBackground); }
.search-row { position: relative; }
.search-input {
  width: 100%;
  padding: 6px 10px 6px 28px;
  font-size: 12px;
  font-family: inherit;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, #444);
  border-radius: 5px;
  outline: none;
}
.search-input:focus { border-color: var(--vscode-focusBorder); }
.search-icon {
  position: absolute; left: 9px; top: 50%; transform: translateY(-50%);
  opacity: 0.45; font-size: 11px; pointer-events: none;
}
.divider { height: 1px; background: var(--vscode-editorWidget-border, rgba(255,255,255,0.08)); margin: 0; }

.session-list { flex: 1; overflow-y: auto; padding: 6px 6px 10px; }
.session-group-label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  opacity: 0.45;
  font-weight: 600;
  padding: 8px 8px 4px;
}
.session-row {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 8px;
  border: none;
  background: transparent;
  color: var(--vscode-foreground);
  border-radius: 5px;
  cursor: pointer;
  text-align: left;
  font-family: inherit;
  font-size: 12px;
}
.session-row:hover { background: var(--vscode-list-hoverBackground); }
.session-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.session-time { font-size: 10px; opacity: 0.45; flex-shrink: 0; }
.session-empty { padding: 16px 10px; font-size: 11px; opacity: 0.5; text-align: center; }
.session-actions { display: none; gap: 2px; flex-shrink: 0; }
.session-row:hover .session-actions { display: flex; }
.session-action-btn {
  padding: 1px 5px;
  font-size: 11px;
  font-family: inherit;
  border: none;
  background: transparent;
  color: var(--vscode-foreground);
  cursor: pointer;
  border-radius: 3px;
  opacity: 0.55;
}
.session-action-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.08)); }

.footer {
  display: flex;
  gap: 6px;
  padding: 8px;
  border-top: 1px solid var(--vscode-editorWidget-border, rgba(255,255,255,0.08));
}
.footer-btn {
  flex: 1;
  padding: 6px 8px;
  font-size: 11px;
  font-family: inherit;
  cursor: pointer;
  border-radius: 5px;
  border: 1px solid var(--vscode-editorWidget-border, rgba(255,255,255,0.12));
  background: transparent;
  color: var(--vscode-foreground);
  opacity: 0.8;
}
.footer-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.06)); border-color: var(--vscode-focusBorder); }
</style>
</head>
<body class="${state === "ready" ? "ready" : ""}">

${state === "loading" ? `
  <div class="spinner"></div>
  <p>Connecting…</p>
` : ""}

${state === "disconnected" ? `
  <h2>Odysseus not found</h2>
  <p>Start Odysseus, then set the correct URL.</p>
  <input class="url-input" id="url-input" type="text" placeholder="http://localhost:7860">
  <button class="btn" id="url-btn">Set URL &amp; retry</button>
  <button class="btn secondary" id="retry-btn">Retry</button>
` : ""}

${state === "auth" ? `
  <h2>Sign in to Odysseus</h2>
  <input class="url-input" id="login-user" type="text" placeholder="Username" autocomplete="username" autocapitalize="off" spellcheck="false">
  <input class="url-input" id="login-pass" type="password" placeholder="Password" autocomplete="current-password">
  <input class="url-input" id="login-totp" type="text" placeholder="2FA code" inputmode="numeric" autocomplete="one-time-code" style="display:none">
  <div class="error-msg" id="auth-error" style="display:none"></div>
  <button class="btn" id="login-btn">Sign in</button>
  <button class="btn secondary" id="login-config-btn">Server settings</button>
` : ""}

${state === "ready" ? `
<div class="ready-view">
  <div class="ready-top">
    <button class="new-chat-btn" id="new-chat">+ New Chat</button>
    <div class="search-row">
      <span class="search-icon">🔍</span>
      <input class="search-input" id="session-search" type="text" placeholder="Search sessions" autocomplete="off" spellcheck="false">
    </div>
  </div>
  <div class="divider"></div>
  <div class="session-list" id="session-list">
    <div class="session-empty">Loading sessions…</div>
  </div>
  <div class="footer">
    <button class="footer-btn" id="configure-btn">⚙ Configure</button>
    <button class="footer-btn" id="signout-btn">↩ Sign out</button>
  </div>
</div>
` : ""}

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const $ = id => document.getElementById(id);

const retryBtn   = $('retry-btn');
const urlBtn     = $('url-btn');
const urlInput   = $('url-input');
const authError  = $('auth-error');

if (retryBtn)   retryBtn.onclick   = () => vscode.postMessage({ type: 'retry' });
if (urlBtn)     urlBtn.onclick     = () => vscode.postMessage({ type: 'setUrl', url: urlInput?.value ?? '' });
if (urlInput)   urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') urlBtn?.click(); });

/* ── Login form ─────────────────────────────────── */
const loginBtn    = $('login-btn');
const loginUser   = $('login-user');
const loginPass   = $('login-pass');
const loginTotp   = $('login-totp');
const loginConfig = $('login-config-btn');

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

if (loginBtn)    loginBtn.onclick    = submitLogin;
if (loginConfig) loginConfig.onclick = () => vscode.postMessage({ type: 'configure' });
[loginUser, loginPass, loginTotp].forEach(el => {
  if (el) el.addEventListener('keydown', e => { if (e.key === 'Enter') submitLogin(); });
});
setTimeout(() => loginUser?.focus(), 50);

/* ── History sidebar (ready state) ──────────────── */
const newChatBtn   = $('new-chat');
const sessionList  = $('session-list');
const sessionSearch= $('session-search');
const configureBtn = $('configure-btn');
const signoutBtn   = $('signout-btn');

let allSessions = [];

if (newChatBtn)   newChatBtn.onclick   = () => vscode.postMessage({ type: 'newSession' });
if (configureBtn) configureBtn.onclick = () => vscode.postMessage({ type: 'configure' });
if (signoutBtn)   signoutBtn.onclick   = () => vscode.postMessage({ type: 'signOut' });
if (sessionSearch) sessionSearch.addEventListener('input', () => renderSessions(sessionSearch.value));

if (sessionList) vscode.postMessage({ type: 'requestSessions' });

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function tsToMs(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const n = Date.parse(v);
  return isNaN(n) ? 0 : n;
}

function sessionTime(s) {
  return tsToMs(s.updated_at) || tsToMs(s.created_at);
}

function relTime(ms) {
  if (!ms) return '';
  const diff = Date.now() - ms;
  const min = Math.floor(diff / 60000);
  if (min < 1)  return 'just now';
  if (min < 60) return min + 'm ago';
  const hr = Math.floor(min / 60);
  if (hr < 24)  return hr + 'h ago';
  const d = new Date(ms);
  const today = new Date(); today.setHours(0,0,0,0);
  const dayStart = new Date(d); dayStart.setHours(0,0,0,0);
  const dayDiff = Math.round((today - dayStart) / 86400000);
  if (dayDiff === 1) return 'yesterday';
  if (dayDiff < 7)   return dayDiff + 'd ago';
  return d.toLocaleDateString();
}

function groupOf(ms) {
  if (!ms) return 'Older';
  const today = new Date(); today.setHours(0,0,0,0);
  const dayStart = new Date(ms); dayStart.setHours(0,0,0,0);
  const dayDiff = Math.round((today - dayStart) / 86400000);
  if (dayDiff <= 0) return 'Today';
  if (dayDiff === 1) return 'Yesterday';
  if (dayDiff < 7)  return 'Last 7 days';
  return 'Older';
}

const GROUP_ORDER = ['Today', 'Yesterday', 'Last 7 days', 'Older'];

function renderSessions(query) {
  if (!sessionList) return;
  const q = (query || '').toLowerCase();
  const filtered = allSessions
    .filter(s => !q || (s.name || '').toLowerCase().includes(q))
    .sort((a, b) => sessionTime(b) - sessionTime(a));

  if (!filtered.length) {
    sessionList.innerHTML = '<div class="session-empty">' +
      (allSessions.length ? 'No matches' : 'No sessions yet') + '</div>';
    return;
  }

  const buckets = {};
  for (const s of filtered) {
    const g = groupOf(sessionTime(s));
    (buckets[g] = buckets[g] || []).push(s);
  }

  let html = '';
  for (const g of GROUP_ORDER) {
    const rows = buckets[g];
    if (!rows || !rows.length) continue;
    html += '<div class="session-group-label">' + g + '</div>';
    for (const s of rows) {
      html += '<div class="session-row" role="button" tabindex="0" data-id="' + escHtml(s.id) + '">' +
        '<span class="session-name">' + escHtml(s.name || 'Untitled') + '</span>' +
        '<span class="session-time">' + escHtml(relTime(sessionTime(s))) + '</span>' +
        '<span class="session-actions">' +
          '<button class="session-action-btn rename-btn" data-id="' + escHtml(s.id) + '" title="Rename">✏</button>' +
          '<button class="session-action-btn delete-btn" data-id="' + escHtml(s.id) + '" title="Delete">🗑</button>' +
        '</span>' +
      '</div>';
    }
  }
  sessionList.innerHTML = html;
  sessionList.querySelectorAll('.session-row').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.session-actions')) return;
      vscode.postMessage({ type: 'openSession', sessionId: el.dataset.id });
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (!e.target.closest('.session-actions')) {
          vscode.postMessage({ type: 'openSession', sessionId: el.dataset.id });
        }
      }
    });
  });
  sessionList.querySelectorAll('.rename-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: 'renameSession', sessionId: btn.dataset.id });
    });
  });
  sessionList.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: 'deleteSession', sessionId: btn.dataset.id });
    });
  });
}

window.addEventListener('message', e => {
  const msg = e.data;
  if (msg.type === 'authError') {
    if (authError) { authError.textContent = msg.message; authError.style.display = ''; }
    if (loginBtn) { loginBtn.disabled = false; loginBtn.textContent = 'Sign in'; }
  }
  if (msg.type === 'requireTotp') {
    if (loginTotp) { loginTotp.style.display = ''; loginTotp.focus(); }
    if (authError) { authError.textContent = 'Enter your 2FA code.'; authError.style.display = ''; }
    if (loginBtn) { loginBtn.disabled = false; loginBtn.textContent = 'Sign in'; }
  }
  if (msg.type === 'sessionsLoaded') {
    allSessions = msg.sessions || [];
    renderSessions(sessionSearch ? sessionSearch.value : '');
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
