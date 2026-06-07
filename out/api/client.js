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
exports.OdysseusClient = void 0;
const https = __importStar(require("https"));
const http = __importStar(require("http"));
class OdysseusClient {
    constructor(baseUrl, token) {
        this.baseUrl = baseUrl.replace(/\/$/, "");
        this.token = token;
    }
    authHeaders() {
        const h = {};
        if (this.token) {
            h["Authorization"] = `Bearer ${this.token}`;
        }
        return h;
    }
    async getAuthStatus() {
        const res = await this.request("GET", "/api/auth/status");
        return res;
    }
    async resolveDefaultEndpoint() {
        const raw = await this.request("GET", "/api/models");
        const items = Array.isArray(raw) ? raw : (raw.items ?? []);
        const ep = items.find((e) => (e.model_type ?? "llm") === "llm" && (e.models?.length ?? 0) > 0) ??
            items.find((e) => (e.models?.length ?? 0) > 0);
        return { url: ep?.url ?? "", model: ep?.models?.[0] ?? "", endpointId: ep?.endpoint_id };
    }
    async listAvailableModels() {
        try {
            const raw = await this.request("GET", "/api/models");
            const items = Array.isArray(raw) ? raw : (raw.items ?? []);
            console.log(`[Odysseus] /api/models items:`, JSON.stringify(items).slice(0, 300));
            const out = [];
            for (const ep of items) {
                for (const m of ep.models ?? []) {
                    out.push({ label: `${m} (${ep.endpoint_name ?? ep.url ?? "?"})`, model: m, endpointUrl: ep.url ?? "" });
                }
            }
            return out;
        }
        catch (err) {
            console.error("[Odysseus] listAvailableModels failed:", err);
            return [];
        }
    }
    async createSession(name, modelOverride, endpointUrlOverride) {
        let endpointUrl = endpointUrlOverride ?? "";
        let model = modelOverride ?? "";
        if (!model || !endpointUrl) {
            try {
                const def = await this.resolveDefaultEndpoint();
                if (!endpointUrl) {
                    endpointUrl = def.url;
                }
                if (!model) {
                    model = def.model;
                }
            }
            catch (err) {
                console.error("[Odysseus] resolveDefaultEndpoint failed:", err);
            }
        }
        const res = await this.requestForm("POST", "/api/session", {
            name,
            endpoint_url: endpointUrl,
            model,
            skip_validation: "true",
        });
        return res;
    }
    async listSessions() {
        try {
            const res = await this.request("GET", "/api/sessions");
            return res.sessions ?? res ?? [];
        }
        catch {
            return [];
        }
    }
    async getSession(id) {
        try {
            const sessions = await this.listSessions();
            return sessions.find((s) => s.id === id) ?? null;
        }
        catch {
            return null;
        }
    }
    async updateSessionModel(id, model, endpointUrl) {
        await this.requestForm("PATCH", `/api/session/${id}`, {
            model,
            endpoint_url: endpointUrl,
        });
    }
    async listEndpoints() {
        try {
            const res = await this.request("GET", "/api/endpoints");
            return res;
        }
        catch {
            return [];
        }
    }
    async createDocument(title, language, content, sessionId) {
        const res = await this.request("POST", "/api/documents", {
            title,
            language,
            content,
            session_id: sessionId,
        });
        return res;
    }
    async updateDocument(id, content) {
        await this.request("PATCH", `/api/document/${id}`, { content });
    }
    async getDocument(id) {
        const res = await this.request("GET", `/api/document/${id}`);
        return res;
    }
    async listModels() {
        try {
            const list = await this.listAvailableModels();
            return list.map((m) => m.model);
        }
        catch {
            return [];
        }
    }
    requestForm(method, path, fields) {
        const boundary = `----FormBoundary${Date.now()}`;
        const parts = Object.entries(fields).map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}`);
        const body = parts.join("\r\n") + `\r\n--${boundary}--\r\n`;
        const bodyBuf = Buffer.from(body, "utf-8");
        return new Promise((resolve, reject) => {
            const url = new URL(this.baseUrl + path);
            const isHttps = url.protocol === "https:";
            const lib = isHttps ? https : http;
            const headers = {
                ...this.authHeaders(),
                "Content-Type": `multipart/form-data; boundary=${boundary}`,
                "Content-Length": bodyBuf.length.toString(),
            };
            const req = lib.request({
                hostname: url.hostname,
                port: url.port || (isHttps ? 443 : 80),
                path: url.pathname + url.search,
                method,
                headers,
            }, (res) => {
                const chunks = [];
                res.on("data", (c) => chunks.push(c));
                res.on("end", () => {
                    const raw = Buffer.concat(chunks).toString();
                    if (!res.statusCode || res.statusCode >= 400) {
                        reject(new Error(`HTTP ${res.statusCode}: ${raw}`));
                        return;
                    }
                    try {
                        resolve(JSON.parse(raw));
                    }
                    catch {
                        resolve(raw);
                    }
                });
            });
            req.on("error", reject);
            req.write(bodyBuf);
            req.end();
        });
    }
    request(method, path, body) {
        return new Promise((resolve, reject) => {
            const url = new URL(this.baseUrl + path);
            const isHttps = url.protocol === "https:";
            const lib = isHttps ? https : http;
            const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
            const headers = {
                ...this.authHeaders(),
                "Content-Type": "application/json",
            };
            if (bodyStr) {
                headers["Content-Length"] = Buffer.byteLength(bodyStr).toString();
            }
            const req = lib.request({
                hostname: url.hostname,
                port: url.port || (isHttps ? 443 : 80),
                path: url.pathname + url.search,
                method,
                headers,
            }, (res) => {
                const chunks = [];
                res.on("data", (c) => chunks.push(c));
                res.on("end", () => {
                    const raw = Buffer.concat(chunks).toString();
                    if (!res.statusCode || res.statusCode >= 400) {
                        reject(new Error(`HTTP ${res.statusCode}: ${raw}`));
                        return;
                    }
                    try {
                        resolve(JSON.parse(raw));
                    }
                    catch {
                        resolve(raw);
                    }
                });
            });
            req.on("error", reject);
            if (bodyStr) {
                req.write(bodyStr);
            }
            req.end();
        });
    }
    buildChatStreamUrl() {
        return `${this.baseUrl}/api/chat_stream`;
    }
}
exports.OdysseusClient = OdysseusClient;
//# sourceMappingURL=client.js.map