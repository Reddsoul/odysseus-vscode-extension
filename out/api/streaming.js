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
exports.streamChat = streamChat;
const https = __importStar(require("https"));
const http = __importStar(require("http"));
async function streamChat(opts) {
    const { baseUrl, token, sessionId, message, activeDocId, agentMode, allowBash, allowWebSearch, onEvent } = opts;
    const boundary = `----OdysseusBoundary${Date.now()}`;
    const parts = [];
    const addField = (name, value) => {
        parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}`);
    };
    addField("message", message);
    addField("session", sessionId);
    addField("mode", agentMode ? "agent" : "chat");
    if (allowBash) {
        addField("allow_bash", "true");
    }
    if (allowWebSearch) {
        addField("allow_web_search", "true");
    }
    if (activeDocId) {
        addField("active_doc_id", activeDocId);
    }
    const body = parts.join("\r\n") + `\r\n--${boundary}--\r\n`;
    const bodyBuf = Buffer.from(body, "utf-8");
    const url = new URL(`${baseUrl}/api/chat_stream`);
    const isHttps = url.protocol === "https:";
    const lib = isHttps ? https : http;
    const headers = {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": bodyBuf.length.toString(),
        Accept: "text/event-stream",
    };
    if (token) {
        headers["Authorization"] = `Bearer ${token}`;
    }
    return new Promise((resolve, reject) => {
        const req = lib.request({
            hostname: url.hostname,
            port: url.port || (isHttps ? 443 : 80),
            path: url.pathname + url.search,
            method: "POST",
            headers,
        }, (res) => {
            if (!res.statusCode || res.statusCode >= 400) {
                let errBody = "";
                res.on("data", (c) => (errBody += c.toString()));
                res.on("end", () => reject(new Error(`HTTP ${res.statusCode}: ${errBody}`)));
                return;
            }
            let buffer = "";
            res.on("data", (chunk) => {
                buffer += chunk.toString();
                const lines = buffer.split("\n\n");
                buffer = lines.pop() ?? "";
                for (const block of lines) {
                    const dataLine = block
                        .split("\n")
                        .find((l) => l.startsWith("data: "));
                    if (!dataLine) {
                        continue;
                    }
                    const raw = dataLine.slice(6).trim();
                    if (raw === "[DONE]") {
                        onEvent({ type: "done" });
                        continue;
                    }
                    try {
                        const parsed = JSON.parse(raw);
                        const event = parseEvent(parsed);
                        if (event) {
                            onEvent(event);
                        }
                    }
                    catch {
                        // malformed chunk — skip
                    }
                }
            });
            res.on("end", () => resolve());
            res.on("error", reject);
        });
        req.on("error", reject);
        req.write(bodyBuf);
        req.end();
    });
}
function parseEvent(data) {
    if (typeof data.delta === "string") {
        if (data.thinking) {
            return { type: "thinking", text: data.delta };
        }
        return { type: "delta", text: data.delta };
    }
    if (data.type === "tool_start") {
        return {
            type: "tool_start",
            tool: String(data.tool ?? ""),
            command: data.command !== undefined ? String(data.command) : undefined,
            round: typeof data.round === "number" ? data.round : undefined,
        };
    }
    if (data.type === "tool_output") {
        return {
            type: "tool_output",
            tool: String(data.tool ?? ""),
            output: String(data.output ?? ""),
            exit_code: typeof data.exit_code === "number" ? data.exit_code : undefined,
        };
    }
    if (data.type === "agent_step") {
        return { type: "agent_step", round: Number(data.round ?? 0) };
    }
    if (data.type === "web_sources") {
        return {
            type: "tool_start",
            tool: "web_sources",
            command: `${Array.isArray(data.data) ? data.data.length : "?"} results`,
        };
    }
    return null;
}
//# sourceMappingURL=streaming.js.map