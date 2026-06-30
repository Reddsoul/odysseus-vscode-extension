import * as https from "https";
import * as http from "http";

export type OdysseyEvent =
  | { type: "delta"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_start"; tool: string; command?: string; round?: number; tool_input?: string }
  | { type: "tool_output"; tool: string; output: string; exit_code?: number }
  | { type: "agent_step"; round: number }
  | { type: "model_info"; model: string; characterName?: string }
  | { type: "metrics"; inputTokens: number; outputTokens: number; tokensPerSec?: number; contextPct?: number }
  | { type: "memories_used"; count: number; items: Array<{ text: string; category?: string }> }
  | { type: "rag_sources"; count: number; items: Array<{ path: string; snippet?: string }> }
  | { type: "error"; message: string }
  | { type: "done" };

export type EventCallback = (event: OdysseyEvent) => void;

export interface StreamChatOptions {
  baseUrl: string;
  token: string | undefined;
  sessionId: string;
  message: string;
  activeDocId: string | undefined;
  agentMode: boolean;
  allowBash: boolean;
  allowWebSearch: boolean;
  tzOffset?: number;
  allowRag?: boolean;
  incognito?: boolean;
  presetId?: string;
  attachments?: string[];
  workspace?: string;
  onEvent: EventCallback;
}

export async function streamChat(opts: StreamChatOptions): Promise<void> {
  const { baseUrl, token, sessionId, message, activeDocId, agentMode, allowBash, allowWebSearch, tzOffset, allowRag, incognito, presetId, attachments, workspace, onEvent } = opts;

  const boundary = `----OdysseusBoundary${Date.now()}`;
  const parts: string[] = [];

  const addField = (name: string, value: string) => {
    parts.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}`
    );
  };

  addField("message", message);
  addField("session", sessionId);
  addField("mode", agentMode ? "agent" : "chat");
  if (allowBash)      { addField("allow_bash", "true"); }
  if (allowWebSearch) { addField("allow_web_search", "true"); }
  if (allowRag)       { addField("use_rag", "true"); }
  if (incognito)      { addField("incognito", "true"); }
  if (presetId)       { addField("preset_id", presetId); }
  if (attachments && attachments.length > 0) { addField("attachments", JSON.stringify(attachments)); }
  if (workspace) { addField("workspace", workspace); }
  if (activeDocId) {
    addField("active_doc_id", activeDocId);
  }

  const body = parts.join("\r\n") + `\r\n--${boundary}--\r\n`;
  const bodyBuf = Buffer.from(body, "utf-8");

  const url = new URL(`${baseUrl.replace(/\/$/, "")}/api/chat_stream`);
  const isHttps = url.protocol === "https:";
  const lib = isHttps ? https : http;

  const headers: Record<string, string> = {
    "Content-Type": `multipart/form-data; boundary=${boundary}`,
    "Content-Length": bodyBuf.length.toString(),
    Accept: "text/event-stream",
  };
  if (tzOffset !== undefined) {
    headers["X-TZ-Offset"] = String(tzOffset);
  }
  if (token) {
    // ody_ tokens are API tokens (Bearer); otherwise it's a session cookie.
    if (token.startsWith("ody_")) {
      headers["Authorization"] = `Bearer ${token}`;
    } else {
      headers["Cookie"] = `odysseus_session=${token}`;
    }
  }

  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: "POST",
        headers,
      },
      (res) => {
        if (!res.statusCode || res.statusCode >= 400) {
          let errBody = "";
          res.on("data", (c: Buffer) => (errBody += c.toString()));
          res.on("end", () =>
            reject(new Error(`HTTP ${res.statusCode}: ${errBody}`))
          );
          return;
        }

        console.log(`[Odysseus] stream connected: HTTP ${res.statusCode}`);
        let buffer = "";
        let eventCount = 0;
        let deltaCount = 0;
        let unknownRaws: string[] = [];

        res.on("data", (chunk: Buffer) => {
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
              eventCount++;
              if (event) {
                if (event.type === "delta") { deltaCount++; }
                onEvent(event);
              } else {
                // Unrecognized event — log the raw shape for debugging
                if (unknownRaws.length < 3) {
                  unknownRaws.push(raw.slice(0, 200));
                }
              }
            } catch {
              // malformed chunk — skip
            }
          }
        });

        res.on("end", () => {
          // Flush any remaining buffered data that lacked a trailing \n\n
          if (buffer.trim()) {
            const dataLine = buffer.split("\n").find((l) => l.startsWith("data: "));
            if (dataLine) {
              const raw = dataLine.slice(6).trim();
              if (raw && raw !== "[DONE]") {
                try {
                  const parsed = JSON.parse(raw);
                  const event = parseEvent(parsed);
                  if (event) { onEvent(event); }
                } catch { /* malformed — skip */ }
              }
            }
          }
          console.log(`[Odysseus] stream ended: ${eventCount} events, ${deltaCount} deltas` +
            (unknownRaws.length ? `, ${unknownRaws.length} unrecognized: ${unknownRaws.join(" | ")}` : ""));
          resolve();
        });
        res.on("error", reject);
      }
    );

    req.on("error", reject);
    req.write(bodyBuf);
    req.end();
  });
}

export async function resumeChat(opts: { baseUrl: string; token: string | undefined; sessionId: string; onEvent: EventCallback }): Promise<void> {
  const { baseUrl, token, sessionId, onEvent } = opts;
  const url = new URL(`${baseUrl}/api/chat/resume/${sessionId}`);
  const isHttps = url.protocol === "https:";
  const lib = isHttps ? https : http;
  const headers: Record<string, string> = { Accept: "text/event-stream" };
  if (token) {
    if (token.startsWith("ody_")) {
      headers["Authorization"] = `Bearer ${token}`;
    } else {
      headers["Cookie"] = `odysseus_session=${token}`;
    }
  }
  return new Promise((resolve, reject) => {
    const req = lib.request({ hostname: url.hostname, port: url.port || (isHttps ? 443 : 80), path: url.pathname, method: "GET", headers }, (res) => {
      if (!res.statusCode || res.statusCode >= 400) {
        let b = ""; res.on("data", (c: Buffer) => (b += c)); res.on("end", () => reject(new Error(`HTTP ${res.statusCode}: ${b}`))); return;
      }
      let buffer = "";
      res.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n\n"); buffer = lines.pop() ?? "";
        for (const block of lines) {
          const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
          if (!dataLine) { continue; }
          const raw = dataLine.slice(6).trim();
          if (raw === "[DONE]") { onEvent({ type: "done" }); continue; }
          try { const parsed = JSON.parse(raw); const event = parseEvent(parsed); if (event) { onEvent(event); } } catch { /* skip */ }
        }
      });
      res.on("end", () => resolve()); res.on("error", reject);
    });
    req.on("error", reject); req.end();
  });
}

export async function streamResearch(opts: { baseUrl: string; token: string | undefined; sessionId: string; onEvent: EventCallback }): Promise<void> {
  const { baseUrl, token, sessionId, onEvent } = opts;
  const url = new URL(`${baseUrl}/api/research/stream/${sessionId}`);
  const isHttps = url.protocol === "https:";
  const lib = isHttps ? https : http;
  const headers: Record<string, string> = { Accept: "text/event-stream" };
  if (token) {
    if (token.startsWith("ody_")) {
      headers["Authorization"] = `Bearer ${token}`;
    } else {
      headers["Cookie"] = `odysseus_session=${token}`;
    }
  }
  return new Promise((resolve, reject) => {
    const req = lib.request({ hostname: url.hostname, port: url.port || (isHttps ? 443 : 80), path: url.pathname, method: "GET", headers }, (res) => {
      if (!res.statusCode || res.statusCode >= 400) {
        let b = ""; res.on("data", (c: Buffer) => (b += c)); res.on("end", () => reject(new Error(`HTTP ${res.statusCode}: ${b}`))); return;
      }
      let buffer = "";
      res.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n\n"); buffer = lines.pop() ?? "";
        for (const block of lines) {
          const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
          if (!dataLine) { continue; }
          const raw = dataLine.slice(6).trim();
          if (raw === "[DONE]") { onEvent({ type: "done" }); continue; }
          try {
            const parsed = JSON.parse(raw);
            if (parsed.type === "research_progress" && parsed.message) {
              onEvent({ type: "delta", text: "\n_" + String(parsed.message) + "_" });
            } else if (parsed.type === "research_done") {
              onEvent({ type: "done" });
            } else {
              const event = parseEvent(parsed);
              if (event) { onEvent(event); }
            }
          } catch { /* skip */ }
        }
      });
      res.on("end", () => resolve()); res.on("error", reject);
    });
    req.on("error", reject); req.end();
  });
}

function parseEvent(data: Record<string, unknown>): OdysseyEvent | null {
  if (typeof data.delta === "string") {
    if (data.thinking) { return { type: "thinking", text: data.delta }; }
    return { type: "delta", text: data.delta };
  }
  if (data.type === "tool_start") {
    // NOTE: backend currently only emits `command` for bash; there is no generic
    // structured-args field. We capture `tool_input`/`input`/`args` if present so
    // verbose mode can render real args once the backend supplies them.
    let toolInput: string | undefined;
    const rawInput = data.tool_input ?? data.input ?? data.args;
    if (rawInput !== undefined && rawInput !== null) {
      toolInput = typeof rawInput === "string" ? rawInput : JSON.stringify(rawInput, null, 2);
    }
    return {
      type: "tool_start",
      tool: String(data.tool ?? ""),
      command: data.command !== undefined ? String(data.command) : undefined,
      round: typeof data.round === "number" ? data.round : undefined,
      tool_input: toolInput,
    };
  }
  if (data.type === "tool_output") {
    return {
      type: "tool_output",
      tool: String(data.tool ?? ""),
      output: String(data.output ?? ""),
      exit_code:
        typeof data.exit_code === "number" ? data.exit_code : undefined,
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
  if (data.type === "model_info") {
    return {
      type: "model_info",
      model: String(data.model ?? ""),
      characterName: data.character_name ? String(data.character_name) : undefined,
    };
  }
  if (data.type === "memories_used" && Array.isArray(data.data)) {
    return { type: "memories_used", count: (data.data as unknown[]).length, items: data.data as Array<{ text: string; category?: string }> };
  }
  if (data.type === "rag_sources" && Array.isArray(data.data)) {
    return { type: "rag_sources", count: (data.data as unknown[]).length, items: data.data as Array<{ path: string; snippet?: string }> };
  }
  if (data.type === "metrics" && data.data) {
    const d = data.data as Record<string, number>;
    return {
      type: "metrics",
      inputTokens: d.input_tokens ?? 0,
      outputTokens: d.output_tokens ?? 0,
      tokensPerSec: d.tokens_per_second,
      contextPct: d.context_percent,
    };
  }
  return null;
}
