import * as https from "https";
import * as http from "http";

export interface AuthStatus {
  authenticated: boolean;
  configured: boolean;
  username?: string;
}

export interface Session {
  id: string;
  name: string;
  model: string;
  endpoint_url: string;
}

export interface Document {
  id: string;
  title: string;
  language: string;
  content: string;
}

export class OdysseusClient {
  private baseUrl: string;
  private token: string | undefined;

  constructor(baseUrl: string, token?: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
  }

  private authHeaders(): Record<string, string> {
    const h: Record<string, string> = {};
    if (this.token) {
      h["Authorization"] = `Bearer ${this.token}`;
    }
    return h;
  }

  async getAuthStatus(): Promise<AuthStatus> {
    const res = await this.request("GET", "/api/auth/status");
    return res as AuthStatus;
  }

  async resolveDefaultEndpoint(): Promise<{ url: string; model: string; endpointId?: string }> {
    const raw = await this.request("GET", "/api/models");
    const items: Array<{ url?: string; models?: string[]; model_type?: string; endpoint_id?: string }> =
      Array.isArray(raw) ? raw : ((raw as { items?: unknown[] }).items ?? []) as typeof items;
    const ep =
      items.find((e) => (e.model_type ?? "llm") === "llm" && (e.models?.length ?? 0) > 0) ??
      items.find((e) => (e.models?.length ?? 0) > 0);
    return { url: ep?.url ?? "", model: ep?.models?.[0] ?? "", endpointId: ep?.endpoint_id };
  }

  async listAvailableModels(): Promise<Array<{ label: string; model: string; endpointUrl: string }>> {
    try {
      const raw = await this.request("GET", "/api/models");
      const items: Array<{ url?: string; models?: string[]; model_type?: string; endpoint_name?: string }> =
        Array.isArray(raw) ? raw : ((raw as { items?: unknown[] }).items ?? []) as typeof items;
      console.log(`[Odysseus] /api/models items:`, JSON.stringify(items).slice(0, 300));
      const out: Array<{ label: string; model: string; endpointUrl: string }> = [];
      for (const ep of items) {
        for (const m of ep.models ?? []) {
          out.push({ label: `${m} (${ep.endpoint_name ?? ep.url ?? "?"})`, model: m, endpointUrl: ep.url ?? "" });
        }
      }
      return out;
    } catch (err) {
      console.error("[Odysseus] listAvailableModels failed:", err);
      return [];
    }
  }

  async createSession(name: string, modelOverride?: string, endpointUrlOverride?: string): Promise<Session> {
    let endpointUrl = endpointUrlOverride ?? "";
    let model = modelOverride ?? "";
    if (!model || !endpointUrl) {
      try {
        const def = await this.resolveDefaultEndpoint();
        if (!endpointUrl) { endpointUrl = def.url; }
        if (!model) { model = def.model; }
      } catch (err) {
        console.error("[Odysseus] resolveDefaultEndpoint failed:", err);
      }
    }
    const res = await this.requestForm("POST", "/api/session", {
      name,
      endpoint_url: endpointUrl,
      model,
      skip_validation: "true",
    });
    return res as Session;
  }

  async listSessions(): Promise<Session[]> {
    try {
      const res = await this.request("GET", "/api/sessions");
      return (res as { sessions?: Session[] }).sessions ?? (res as Session[]) ?? [];
    } catch {
      return [];
    }
  }

  async getSession(id: string): Promise<Session | null> {
    try {
      const sessions = await this.listSessions();
      return sessions.find((s) => s.id === id) ?? null;
    } catch {
      return null;
    }
  }

  async updateSessionModel(id: string, model: string, endpointUrl: string): Promise<void> {
    await this.requestForm("PATCH", `/api/session/${id}`, {
      model,
      endpoint_url: endpointUrl,
    });
  }

  async listEndpoints(): Promise<Array<{ id: string; name: string; base_url: string; cached_models: string | string[]; is_enabled: boolean }>> {
    try {
      const res = await this.request("GET", "/api/endpoints");
      return res as Array<{ id: string; name: string; base_url: string; cached_models: string | string[]; is_enabled: boolean }>;
    } catch {
      return [];
    }
  }

  async createDocument(
    title: string,
    language: string,
    content: string,
    sessionId: string
  ): Promise<Document> {
    const res = await this.request("POST", "/api/documents", {
      title,
      language,
      content,
      session_id: sessionId,
    });
    return res as Document;
  }

  async updateDocument(id: string, content: string): Promise<void> {
    await this.request("PATCH", `/api/document/${id}`, { content });
  }

  async getDocument(id: string): Promise<Document> {
    const res = await this.request("GET", `/api/document/${id}`);
    return res as Document;
  }

  async listModels(): Promise<string[]> {
    try {
      const list = await this.listAvailableModels();
      return list.map((m) => m.model);
    } catch {
      return [];
    }
  }

  private requestForm(
    method: string,
    path: string,
    fields: Record<string, string>
  ): Promise<unknown> {
    const boundary = `----FormBoundary${Date.now()}`;
    const parts = Object.entries(fields).map(
      ([k, v]) =>
        `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}`
    );
    const body = parts.join("\r\n") + `\r\n--${boundary}--\r\n`;
    const bodyBuf = Buffer.from(body, "utf-8");

    return new Promise((resolve, reject) => {
      const url = new URL(this.baseUrl + path);
      const isHttps = url.protocol === "https:";
      const lib = isHttps ? https : http;
      const headers: Record<string, string> = {
        ...this.authHeaders(),
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": bodyBuf.length.toString(),
      };
      const req = lib.request(
        {
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname + url.search,
          method,
          headers,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const raw = Buffer.concat(chunks).toString();
            if (!res.statusCode || res.statusCode >= 400) {
              reject(new Error(`HTTP ${res.statusCode}: ${raw}`));
              return;
            }
            try { resolve(JSON.parse(raw)); } catch { resolve(raw); }
          });
        }
      );
      req.on("error", reject);
      req.write(bodyBuf);
      req.end();
    });
  }

  private request(
    method: string,
    path: string,
    body?: unknown
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const url = new URL(this.baseUrl + path);
      const isHttps = url.protocol === "https:";
      const lib = isHttps ? https : http;

      const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
      const headers: Record<string, string> = {
        ...this.authHeaders(),
        "Content-Type": "application/json",
      };
      if (bodyStr) {
        headers["Content-Length"] = Buffer.byteLength(bodyStr).toString();
      }

      const req = lib.request(
        {
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname + url.search,
          method,
          headers,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const raw = Buffer.concat(chunks).toString();
            if (!res.statusCode || res.statusCode >= 400) {
              reject(new Error(`HTTP ${res.statusCode}: ${raw}`));
              return;
            }
            try {
              resolve(JSON.parse(raw));
            } catch {
              resolve(raw);
            }
          });
        }
      );

      req.on("error", reject);
      if (bodyStr) {
        req.write(bodyStr);
      }
      req.end();
    });
  }

  buildChatStreamUrl(): string {
    return `${this.baseUrl}/api/chat_stream`;
  }
}
