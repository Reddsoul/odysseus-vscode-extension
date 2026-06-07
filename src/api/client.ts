import * as https from "https";
import * as http from "http";

export interface AuthStatus {
  authenticated: boolean;
  configured: boolean;
  username?: string;
  is_admin?: boolean;
  signup_enabled?: boolean;
}

export interface LoginResult {
  ok: boolean;
  token?: string;
  username?: string;
  requiresTotp?: boolean;
  error?: string;
}

/** The session cookie name the Odysseus backend issues on login. */
export const SESSION_COOKIE = "odysseus_session";

/** Extract a cookie value from a Set-Cookie header list. */
function extractCookie(setCookie: string[] | undefined, name: string): string | undefined {
  for (const line of setCookie ?? []) {
    const m = line.match(new RegExp(`^${name}=([^;]+)`));
    if (m) { return m[1]; }
  }
  return undefined;
}

export interface Session {
  id: string;
  name: string;
  model: string;
  endpoint_url: string;
  created_at?: string | number;
  updated_at?: string | number;
  is_important?: boolean;
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
    if (!this.token) { return h; }
    // `ody_` tokens are admin-created API tokens → Bearer auth.
    // Anything else is a session-cookie token from username/password login.
    if (this.token.startsWith("ody_")) {
      h["Authorization"] = `Bearer ${this.token}`;
    } else {
      h["Cookie"] = `${SESSION_COOKIE}=${this.token}`;
    }
    return h;
  }

  async getAuthStatus(): Promise<AuthStatus> {
    const res = await this.request("GET", "/api/auth/status");
    return res as AuthStatus;
  }

  /**
   * Log in with username/password. On success returns the session token
   * (the value of the odysseus_session cookie) to store in VS Code secrets.
   * If the account has 2FA, the first call returns { requiresTotp: true };
   * call again with totpCode set.
   */
  async login(username: string, password: string, totpCode?: string): Promise<LoginResult> {
    const payload: Record<string, unknown> = {
      username: username.trim(),
      password,
      remember: true,
    };
    if (totpCode) { payload.totp_code = totpCode.trim(); }

    let res: { status: number; body: string; setCookie?: string[] };
    try {
      res = await this.rawRequest("POST", "/api/auth/login", payload);
    } catch (err) {
      return { ok: false, error: `Cannot reach Odysseus: ${String(err)}` };
    }

    if (res.status === 429) {
      return { ok: false, error: "Too many attempts — wait a minute and try again." };
    }
    if (res.status === 401) {
      return { ok: false, error: parseErrorBody(res.body) || "Invalid username or password." };
    }

    let data: Record<string, unknown> = {};
    try { data = JSON.parse(res.body); } catch { /* non-JSON */ }

    if (res.status >= 400) {
      return { ok: false, error: parseErrorBody(res.body) || `Login failed (HTTP ${res.status}).` };
    }
    if (data.requires_totp) {
      return { ok: false, requiresTotp: true, username: String(data.username ?? username) };
    }
    if (!data.ok) {
      return { ok: false, error: String(data.error ?? "Login failed.") };
    }

    const token = extractCookie(res.setCookie, SESSION_COOKIE);
    if (!token) {
      return { ok: false, error: "Login succeeded but no session cookie was returned." };
    }
    return { ok: true, token, username: String(data.username ?? username) };
  }

  /** Best-effort logout — revokes the session token on the server. */
  async logout(): Promise<void> {
    try { await this.request("POST", "/api/auth/logout"); } catch { /* ignore */ }
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

  async renameSession(id: string, name: string): Promise<void> {
    await this.requestForm("PATCH", `/api/session/${id}`, { name });
  }

  async deleteSession(id: string): Promise<void> {
    await this.request("DELETE", `/api/session/${id}`);
  }

  async getSessionMessages(id: string): Promise<Array<{ role: string; content: string; created_at?: string }>> {
    try {
      const res = await this.request("GET", `/api/history/${id}`);
      return (res as { history?: Array<{ role: string; content: string; created_at?: string }> }).history ?? [];
    } catch {
      return [];
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

  /** Like request(), but resolves with status code, raw body, and Set-Cookie
   *  instead of throwing on 4xx — used by login() to read the session cookie. */
  private rawRequest(
    method: string,
    path: string,
    body?: unknown
  ): Promise<{ status: number; body: string; setCookie?: string[] }> {
    return new Promise((resolve, reject) => {
      const url = new URL(this.baseUrl + path);
      const isHttps = url.protocol === "https:";
      const lib = isHttps ? https : http;

      const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
      const headers: Record<string, string> = {
        ...this.authHeaders(),
        "Content-Type": "application/json",
        Accept: "application/json",
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
            const setCookie = res.headers["set-cookie"];
            resolve({
              status: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString(),
              setCookie: Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : undefined,
            });
          });
        }
      );
      req.on("error", reject);
      if (bodyStr) { req.write(bodyStr); }
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

  async stopChat(sessionId: string): Promise<void> {
    try { await this.request("POST", `/api/chat/stop/${sessionId}`); } catch { /* ignore */ }
  }

  async editMessage(sessionId: string, index: number, content: string): Promise<void> {
    await this.requestForm("POST", `/api/session/${sessionId}/edit-message`, {
      message_index: String(index), content,
    });
  }

  async deleteMessages(sessionId: string, from: number, to: number): Promise<void> {
    await this.requestForm("DELETE", `/api/session/${sessionId}/delete-messages`, {
      from: String(from), to: String(to),
    });
  }

  async markSessionImportant(id: string, important: boolean): Promise<void> {
    await this.requestForm("POST", `/api/session/${id}/important`, { important: important ? "true" : "false" });
  }

  async compactSession(id: string): Promise<void> {
    await this.requestForm("POST", `/api/session/${id}/compact`, {});
  }

  async forkSession(id: string, keepCount = 10): Promise<Session> {
    const res = await this.requestForm("POST", `/api/session/${id}/fork`, { keep_count: String(keepCount) });
    return res as Session;
  }

  async truncateSession(id: string, keepCount: number): Promise<void> {
    await this.requestForm("POST", `/api/session/${id}/truncate`, { keep_count: String(keepCount) });
  }

  async getStreamStatus(sessionId: string): Promise<{ status: string; detached?: boolean } | null> {
    try { return await this.request("GET", `/api/chat/stream_status/${sessionId}`) as { status: string; detached?: boolean }; }
    catch { return null; }
  }

  async searchMessages(q: string, limit = 20): Promise<Array<{ session_id: string; session_name: string; role: string; content_snippet: string; timestamp?: string }>> {
    try {
      const res = await this.request("GET", `/api/search?q=${encodeURIComponent(q)}&limit=${limit}`);
      return res as Array<{ session_id: string; session_name: string; role: string; content_snippet: string; timestamp?: string }>;
    } catch { return []; }
  }

  async listPresets(): Promise<Array<{ id: string; name: string; character_name?: string }>> {
    try { return (await this.request("GET", "/api/presets")) as Array<{ id: string; name: string; character_name?: string }>; }
    catch { return []; }
  }

  buildChatStreamUrl(): string {
    return `${this.baseUrl}/api/chat_stream`;
  }

  async listMemories(): Promise<Array<{ id: string; text: string; category: string; timestamp: string; source?: string }>> {
    try { return ((await this.request("GET", "/api/memory")) as { memory: Array<{ id: string; text: string; category: string; timestamp: string }> }).memory ?? []; }
    catch { return []; }
  }

  async addMemory(text: string, category: string): Promise<void> {
    await this.requestForm("POST", "/api/memory/add", { text, category });
  }

  async deleteMemory(id: string): Promise<void> {
    await this.request("DELETE", `/api/memory/${id}`);
  }

  async listNotes(): Promise<Note[]> {
    try { return (await this.request("GET", "/api/notes")) as Note[]; }
    catch { return []; }
  }

  async createNote(title: string, content: string, noteType = "note"): Promise<Note> {
    return (await this.request("POST", "/api/notes", { title, content, note_type: noteType })) as Note;
  }

  async deleteNote(id: string): Promise<void> {
    await this.request("DELETE", `/api/notes/${id}`);
  }

  async toggleTodoItem(noteId: string, index: number): Promise<void> {
    await this.request("POST", `/api/notes/${noteId}/items/${index}/toggle`);
  }

  async startResearch(query: string, sessionId?: string): Promise<{ session_id: string; task_id?: string }> {
    return (await this.requestForm("POST", "/api/research/start", {
      query,
      ...(sessionId ? { session_id: sessionId } : {}),
    })) as { session_id: string };
  }

  async getResearchReport(researchSessionId: string): Promise<{ report: string; sources: Array<{ url: string; title?: string }> }> {
    return (await this.request("GET", `/api/research/report/${researchSessionId}`)) as { report: string; sources: Array<{ url: string; title?: string }> };
  }

  async uploadFile(filename: string, content: Buffer, mimeType: string): Promise<{ id: string; filename: string; url: string }> {
    const boundary = `----OdysseusBoundary${Date.now()}`;
    const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`;
    const footer = `\r\n--${boundary}--\r\n`;
    const body = Buffer.concat([Buffer.from(header), content, Buffer.from(footer)]);
    return new Promise((resolve, reject) => {
      const url = new URL(this.baseUrl + "/api/upload");
      const isHttps = url.protocol === "https:";
      const lib = isHttps ? https : http;
      const req = lib.request({
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname,
        method: "POST",
        headers: {
          ...this.authHeaders(),
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": body.length,
        },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString();
          if (!res.statusCode || res.statusCode >= 400) { reject(new Error(`HTTP ${res.statusCode}: ${raw}`)); return; }
          try { resolve(JSON.parse(raw)); } catch { reject(new Error("Invalid response")); }
        });
      });
      req.on("error", reject);
      req.write(body);
      req.end();
    });
  }
}

/** Pull a human-readable message out of a FastAPI error body ({"detail": "..."}). */
function parseErrorBody(body: string): string | undefined {
  try {
    const j = JSON.parse(body);
    return (j.detail ?? j.error ?? j.message) as string | undefined;
  } catch {
    return undefined;
  }
}

export interface Note {
  id: string;
  title?: string;
  content?: string;
  note_type: string;
  pinned?: boolean;
  color?: string;
  items?: Array<{ text: string; done: boolean }>;
}
