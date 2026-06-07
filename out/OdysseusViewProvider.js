"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.OdysseusViewProvider = void 0;
const vscode = __importStar(require("vscode"));
const http = __importStar(require("http"));
const client_1 = require("./api/client");
const ChatPanel_1 = require("./ChatPanel");
class OdysseusViewProvider {
    constructor(context) {
        this.context = context;
        this.state = "loading";
    }
    resolveWebviewView(webviewView, _ctx, _token) {
        this.view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this.buildHtml("loading");
        webviewView.webview.onDidReceiveMessage((msg) => this.handleMessage(msg), undefined, this.context.subscriptions);
        this.init();
    }
    async init() {
        this.setState("loading");
        const url = this.getUrl();
        const token = await this.context.secrets.get("odysseus.token");
        this.client = new client_1.OdysseusClient(url, token);
        let status;
        try {
            status = await this.client.getAuthStatus();
        }
        catch {
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
    getUrl() {
        return vscode.workspace
            .getConfiguration("odysseus")
            .get("url", "http://localhost:7860");
    }
    async configure() {
        const url = await vscode.window.showInputBox({
            prompt: "Odysseus server URL",
            value: this.getUrl(),
            placeHolder: "http://localhost:7860",
        });
        if (url === undefined) {
            return;
        }
        await vscode.workspace.getConfiguration("odysseus")
            .update("url", url.trim(), vscode.ConfigurationTarget.Global);
        await this.context.secrets.delete("odysseus.token");
        await this.init();
    }
    async newSession() {
        vscode.commands.executeCommand("odysseus.openChat");
    }
    async sendSelection() {
        vscode.commands.executeCommand("odysseus.openChat");
    }
    async handleMessage(msg) {
        switch (msg.type) {
            case "newSession": {
                const existing = ChatPanel_1.ChatPanel.getCurrent();
                const panel = ChatPanel_1.ChatPanel.createOrShow(this.context);
                if (existing) {
                    await panel.newSession();
                }
                break;
            }
            case "startAuth":
                await this.startBrowserAuth();
                break;
            case "setUrl":
                await this.handleSetUrl(String(msg.url ?? ""));
                break;
            case "retry":
                await this.init();
                break;
        }
    }
    async handleSetUrl(url) {
        const trimmed = url.trim();
        if (!trimmed) {
            return;
        }
        await vscode.workspace.getConfiguration("odysseus")
            .update("url", trimmed, vscode.ConfigurationTarget.Global);
        await this.init();
    }
    async startBrowserAuth() {
        const url = this.getUrl();
        const state = generateNonce();
        let server;
        let port;
        try {
            ({ server, port } = await startCallbackServer());
        }
        catch {
            this.postMessage({ type: "authError", message: "Could not start local callback server." });
            return;
        }
        const callbackUrl = `http://localhost:${port}/vscode-callback`;
        const authUrl = `${url}/api/auth/authorize?callback=${encodeURIComponent(callbackUrl)}&state=${encodeURIComponent(state)}`;
        this.setState("authwaiting");
        await vscode.env.openExternal(vscode.Uri.parse(authUrl));
        try {
            const token = await waitForCallback(server, state, 300000);
            await this.context.secrets.store("odysseus.token", token);
            this.setState("ready");
            // Open the panel now that we're authenticated
            ChatPanel_1.ChatPanel.createOrShow(this.context);
        }
        catch (err) {
            server.close();
            this.setState("auth");
            this.postMessage({ type: "authError", message: String(err) });
        }
    }
    setState(s) {
        this.state = s;
        if (this.view) {
            this.view.webview.html = this.buildHtml(s);
        }
    }
    postMessage(msg) {
        this.view?.webview.postMessage(msg);
    }
    buildHtml(state) {
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
</style>
</head>
<body>

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
  <h2>Connect to Odysseus</h2>
  <p>Open Odysseus in your browser and approve the connection.</p>
  <div class="error-msg" id="auth-error" style="display:none"></div>
  <button class="btn" id="connect-btn">Connect via Browser</button>
` : ""}

${state === "authwaiting" ? `
  <div class="spinner"></div>
  <h2>Waiting for approval…</h2>
  <p>Click <strong>Allow</strong> in your browser.</p>
` : ""}

${state === "ready" ? `
  <p><span class="status-dot"></span>Connected to Odysseus</p>
  <button class="btn" id="open-btn">Open Chat</button>
` : ""}

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const $ = id => document.getElementById(id);

const retryBtn   = $('retry-btn');
const urlBtn     = $('url-btn');
const urlInput   = $('url-input');
const connectBtn = $('connect-btn');
const openBtn    = $('open-btn');
const authError  = $('auth-error');

if (retryBtn)   retryBtn.onclick   = () => vscode.postMessage({ type: 'retry' });
if (connectBtn) connectBtn.onclick = () => vscode.postMessage({ type: 'startAuth' });
if (openBtn)    openBtn.onclick    = () => vscode.postMessage({ type: 'newSession' });
if (urlBtn)     urlBtn.onclick     = () => vscode.postMessage({ type: 'setUrl', url: urlInput?.value ?? '' });
if (urlInput)   urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') urlBtn?.click(); });

window.addEventListener('message', e => {
  if (e.data.type === 'authError' && authError) {
    authError.textContent = e.data.message;
    authError.style.display = '';
  }
});
</script>
</body>
</html>`;
    }
}
exports.OdysseusViewProvider = OdysseusViewProvider;
OdysseusViewProvider.viewId = "odysseus.chatView";
function startCallbackServer() {
    return new Promise((resolve, reject) => {
        const server = http.createServer();
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address();
            resolve({ server, port: addr.port });
        });
        server.on("error", reject);
    });
}
function waitForCallback(server, expectedState, timeoutMs) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            server.close();
            reject(new Error("Timed out waiting for browser authorization (5 min)."));
        }, timeoutMs);
        server.on("request", (req, res) => {
            const reqUrl = new URL(req.url ?? "/", "http://localhost");
            const token = reqUrl.searchParams.get("token");
            const state = reqUrl.searchParams.get("state");
            const error = reqUrl.searchParams.get("error");
            clearTimeout(timer);
            server.close();
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            if (token && state === expectedState) {
                res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Connected</title>
<style>body{font-family:-apple-system,sans-serif;text-align:center;margin-top:100px;background:#0f0f0f;color:#e8e8e8}</style>
</head><body><h2>✓ Connected!</h2><p>You can close this tab.</p></body></html>`);
                resolve(token);
            }
            else {
                res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Denied</title>
<style>body{font-family:-apple-system,sans-serif;text-align:center;margin-top:100px;background:#0f0f0f;color:#e8e8e8}</style>
</head><body><h2>Authorization denied</h2><p>You can close this tab.</p></body></html>`);
                reject(new Error(error === "denied" ? "Authorization denied." : "Invalid callback."));
            }
        });
    });
}
function generateNonce() {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let r = "";
    for (let i = 0; i < 32; i++) {
        r += chars[Math.floor(Math.random() * chars.length)];
    }
    return r;
}
//# sourceMappingURL=OdysseusViewProvider.js.map