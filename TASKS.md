# Odysseus VSCode Extension — Feature Backlog

## Rules

- **One task at a time.** Do not start the next task until the current one validates.
- After every task: `npm run compile` must pass with zero errors.
- Validate manually with `F5` extension host before marking done.
- Tasks within a tier are ordered by priority — do them top-to-bottom.

---

## Regression Baseline

Before any task, verify these still work after each implementation:
- [ ] Auth flow (login screen if no token)
- [ ] Chat sends and streams a response
- [ ] Thinking blocks render and collapse
- [ ] Tool call chips show running → success/error
- [ ] Session list loads in sidebar
- [ ] Context pills show active file + selection
- [ ] Model picker opens and switches models

## HARD — Significant Features (3hr+)

---

### HARD-1 — Edit and delete past messages

**Goal**: Allow users to edit or delete past messages in a session.
- Edit: `POST /api/session/{id}/edit-message` with `message_index` (int) and `content`.
- Delete range: `DELETE /api/session/{id}/delete-messages` with `from` and `to` (indexes).

**Files**: `src/api/client.ts`, `src/ChatPanel.ts`

**Implementation**:

Step 1 — Add to `OdysseusClient`:
```ts
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
```

Step 2 — Track message indexes in `loadHistory`. When rendering history, add `data-index` attribute to each message div:
```js
div.dataset.index = String(i); // i from the for loop
```

Step 3 — Add hover actions to history messages (show on `.msg:hover`):
```css
.msg-actions { display:none; gap:4px; margin-top:4px; }
.msg:hover .msg-actions { display:flex; }
.msg-action-btn { padding:2px 7px; font-size:10px; font-family:inherit; border-radius:3px; border:1px solid rgba(255,255,255,0.1); background:transparent; color:var(--vscode-foreground); cursor:pointer; opacity:0.5; }
.msg-action-btn:hover { opacity:1; background:rgba(255,255,255,0.06); }
```

Step 4 — In `loadHistory` rendering, append actions div:
```js
const actions = document.createElement('div');
actions.className = 'msg-actions';
actions.innerHTML = '<button class="msg-action-btn edit-msg-btn" title="Edit">edit</button><button class="msg-action-btn del-msg-btn" title="Delete">delete</button>';
div.appendChild(actions);
actions.querySelector('.edit-msg-btn')?.addEventListener('click', () => {
  const idx = parseInt(div.dataset.index ?? '-1');
  const current = div.querySelector('.msg-body')?.textContent ?? '';
  vscode.postMessage({ type: 'editMessage', index: idx, currentContent: current });
});
actions.querySelector('.del-msg-btn')?.addEventListener('click', () => {
  const idx = parseInt(div.dataset.index ?? '-1');
  vscode.postMessage({ type: 'deleteMessage', from: idx, to: idx });
});
```

Step 5 — In `handleMessage` ChatPanel:
```ts
case "editMessage": {
  if (!this.client || !this.sessionId) { break; }
  const newText = await vscode.window.showInputBox({
    prompt: "Edit message",
    value: String(msg.currentContent ?? ""),
    placeHolder: "Updated message content",
  });
  if (newText === undefined || !newText.trim()) { break; }
  await this.client.editMessage(this.sessionId, Number(msg.index), newText);
  // Reload history
  const messages = await this.client.getSessionMessages(this.sessionId);
  this.postMessage({ type: "loadHistory", messages });
  break;
}
case "deleteMessage": {
  if (!this.client || !this.sessionId) { break; }
  const confirm = await vscode.window.showQuickPick(["Yes, delete", "Cancel"], { placeHolder: "Delete this message?" });
  if (confirm !== "Yes, delete") { break; }
  await this.client.deleteMessages(this.sessionId, Number(msg.from), Number(msg.to));
  const messages = await this.client.getSessionMessages(this.sessionId);
  this.postMessage({ type: "loadHistory", messages });
  break;
}
```

**Validate**:
- `npm run compile` — zero errors.
- Load a session with history. Hover over a user message → edit/delete buttons appear.
- Edit: input box opens pre-filled → save → history reloads with updated text.
- Delete: confirm prompt → message removed from history.
- Assistant messages also show delete button (no edit for those).

---

### HARD-2 — Memory browser panel

**Goal**: Second view in the sidebar showing the user's stored memories.
Supports browsing, adding, and deleting memories.
APIs: `GET /api/memory`, `POST /api/memory/add`, `DELETE /api/memory/{id}`,
`POST /api/memory/debug` (show which memories fired for a query).

**Files**: `package.json`, `src/extension.ts`, new file `src/MemoryViewProvider.ts`

**Implementation**:

Step 1 — Register a second view in `package.json`:
```json
"views": {
  "odysseus": [
    {
      "type": "webview",
      "id": "odysseus.chatView",
      "name": "Odysseus AI"
    },
    {
      "type": "webview",
      "id": "odysseus.memoryView",
      "name": "Memories"
    }
  ]
}
```

Step 2 — Create `src/MemoryViewProvider.ts`. Model it after `OdysseusViewProvider`.
The webview renders a list of memory items. States: `loading`, `disconnected`, `ready`.

In `ready` state HTML show:
- Add memory input (text field + category dropdown + save button)
- Memory list: each item shows text, category badge, timestamp, delete button
- Search/filter input

Key interactions:
- `requestMemories` → `GET /api/memory` → post `memoriesLoaded`
- `addMemory { text, category }` → `POST /api/memory/add`
- `deleteMemory { id }` → `DELETE /api/memory/{id}`

Add to `OdysseusClient`:
```ts
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
```

Step 3 — Register in `extension.ts`:
```ts
import { MemoryViewProvider } from "./MemoryViewProvider";
const memoryProvider = new MemoryViewProvider(context);
context.subscriptions.push(
  vscode.window.registerWebviewViewProvider("odysseus.memoryView", memoryProvider, {
    webviewOptions: { retainContextWhenHidden: true }
  })
);
```

**Validate**:
- `npm run compile` — zero errors.
- "Memories" view appears below session list in sidebar.
- Lists existing memories with category badges.
- Add button saves new memory — appears in list.
- Delete button removes with confirmation.
- Memories are server-side — verify in Odysseus web UI they match.

---

### HARD-3 — Notes panel

**Goal**: Third sidebar view for Odysseus notes/todos.
APIs: `GET /api/notes`, `POST /api/notes`, `PUT /api/notes/{id}`, `DELETE /api/notes/{id}`,
`POST /api/notes/{id}/items/{index}/toggle` (todo checkboxes).

**Files**: `package.json`, `src/extension.ts`, new `src/NotesViewProvider.ts`

**Implementation**:

Step 1 — Add third view to `package.json`:
```json
{
  "type": "webview",
  "id": "odysseus.notesView",
  "name": "Notes"
}
```

Step 2 — Add to `OdysseusClient`:
```ts
export interface Note { id: string; title?: string; content?: string; note_type: string; pinned?: boolean; color?: string; items?: Array<{ text: string; done: boolean }>; }
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
```

Step 3 — Create `src/NotesViewProvider.ts`. Model after `MemoryViewProvider`.
The webview shows:
- "New Note" and "New Todo" buttons
- Pinned notes at top
- Each note: title, content preview, pin/delete buttons
- Todo notes: checkable item list
- Click note → expand inline or open text editor

Step 4 — Register in `extension.ts`.

**Validate**:
- `npm run compile` — zero errors.
- Notes view appears. Existing notes load.
- "New Note" → title + content → saves → appears in list.
- Delete → note removed.
- Todo items: checkbox toggles done state server-side.

---

### HARD-4 — File and image attachments

**Goal**: `POST /api/upload` uploads a file and returns `{id, filename, url}`.
Pass the ID in the `attachments` JSON array to `chat_stream`. Enables sending images,
PDFs, and text files to the agent.

**Files**: `src/api/client.ts`, `src/api/streaming.ts`, `src/ChatPanel.ts`

**Implementation**:

Step 1 — Add to `OdysseusClient` (multipart file upload — requires raw buffer):
```ts
async uploadFile(filename: string, content: Buffer, mimeType: string): Promise<{ id: string; filename: string; url: string }> {
  const boundary = `----OdysseusBoundary${Date.now()}`;
  const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`;
  const footer = `\r\n--${boundary}--\r\n`;
  const body = Buffer.concat([Buffer.from(header), content, Buffer.from(footer)]);
  return new Promise((resolve, reject) => {
    const url = new URL(this.baseUrl + "/api/upload");
    const isHttps = url.protocol === "https:";
    const lib = isHttps ? https : http;
    const req = lib.request({ hostname: url.hostname, port: url.port || (isHttps ? 443 : 80), path: url.pathname, method: "POST", headers: { ...this.authHeaders(), "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": body.length } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        if (!res.statusCode || res.statusCode >= 400) { reject(new Error(`HTTP ${res.statusCode}: ${raw}`)); return; }
        try { resolve(JSON.parse(raw)); } catch { reject(new Error("Invalid response")); }
      });
    });
    req.on("error", reject); req.write(body); req.end();
  });
}
```

Step 2 — Add `attachments?: string[]` to `StreamChatOptions`. When present:
`addField("attachments", JSON.stringify(opts.attachments))`.

Step 3 — In `ChatPanel.ts`, add a paperclip button in the toolbar:
```html
<button class="icon-btn" id="attach-btn" title="Attach file">
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
</button>
```

Step 4 — Handle `attach` message type in `handleMessage`:
```ts
case "attach": {
  const uris = await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: "Attach" });
  if (!uris || !this.client) { break; }
  const ids: string[] = [];
  for (const uri of uris) {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const filename = uri.fsPath.split("/").pop() ?? "file";
    const mime = filename.endsWith(".png") ? "image/png" : filename.endsWith(".jpg") ? "image/jpeg" : filename.endsWith(".pdf") ? "application/pdf" : "text/plain";
    const result = await this.client.uploadFile(filename, Buffer.from(bytes), mime);
    ids.push(result.id);
  }
  this.pendingAttachments = ids;
  this.postMessage({ type: "attachmentsReady", filenames: uris.map(u => u.fsPath.split("/").pop()) });
  break;
}
```

Step 5 — Add `private pendingAttachments: string[] = []` field. In `handleSend`, pass
`pendingAttachments` to `streamChat` then clear it.

Step 6 — In webview, on `attachmentsReady`, show attachment pills above the input.

**Validate**:
- `npm run compile` — zero errors.
- Click paperclip → file picker opens.
- Select an image → attachment pill appears in input area.
- Send message → agent can see and describe the attached image.
- Multiple files supported.

---

### HARD-5 — Deep research trigger

**Goal**: `POST /api/research/start` kicks off multi-phase deep research.
`GET /api/research/stream/{id}` streams progress as SSE.
`GET /api/research/report/{id}` returns the final report.
Add a "Research" button that starts a research task and streams progress into the chat view.

**Files**: `src/api/client.ts`, `src/ChatPanel.ts`

**Implementation**:

Step 1 — Add to `OdysseusClient`:
```ts
async startResearch(query: string, sessionId?: string): Promise<{ session_id: string; task_id?: string }> {
  return (await this.requestForm("POST", "/api/research/start", { query, ...(sessionId ? { session_id: sessionId } : {}) })) as { session_id: string };
}

async getResearchReport(researchSessionId: string): Promise<{ report: string; sources: Array<{ url: string; title?: string }> }> {
  return (await this.request("GET", `/api/research/report/${researchSessionId}`)) as { report: string; sources: Array<{ url: string; title?: string }> };
}
```

Step 2 — Add `streamResearch` to `streaming.ts` (GET /api/research/stream/{id},
same SSE pattern as `resumeChat`). Emits `research_progress`, `research_done` events.

Step 3 — Add "Research" toolbar button with a microscope icon.

Step 4 — When clicked → `vscode.postMessage({ type: 'research', query: msgInput.value.trim() })`.
Clear input. Show thinking state.

Step 5 — In `handleMessage`:
```ts
case "research": {
  if (!this.client || !this.sessionId) { break; }
  const query = String(msg.query ?? "");
  if (!query) { break; }
  this.postMessage({ type: "userMessage", text: `🔬 Research: ${query}` });
  this.postMessage({ type: "assistantStart" });
  const { session_id: researchId } = await this.client.startResearch(query);
  // Stream progress
  try {
    await streamResearch({ baseUrl: this.getUrl(), token: await this.context.secrets.get("odysseus.token"), sessionId: researchId, onEvent: (event) => { this.postMessage({ type: "streamEvent", event }); } });
  } catch (err) {
    this.postMessage({ type: "streamEvent", event: { type: "error", message: String(err) } });
  }
  // Fetch final report
  try {
    const { report, sources } = await this.client.getResearchReport(researchId);
    this.postMessage({ type: "streamEvent", event: { type: "delta", text: report } });
    if (sources.length) {
      const srcText = "\n\n**Sources:**\n" + sources.map((s, i) => `${i+1}. [${s.title || s.url}](${s.url})`).join("\n");
      this.postMessage({ type: "streamEvent", event: { type: "delta", text: srcText } });
    }
  } catch { /* report not available */ }
  this.postMessage({ type: "assistantDone" });
  break;
}
```

Step 6 — In webview, handle `research_progress` events from the stream to show progress
status in the status message area.

**Validate**:
- `npm run compile` — zero errors.
- Type a research question. Click Research button.
- Progress updates appear while research runs (may take 30-120s depending on query).
- Final report with sources renders in chat with markdown (if MED-3 is done).
- Clicking source links opens browser.

---

## Final Checklist (after all tasks)

```
npm run compile  →  zero errors

Manual smoke test (F5):
- [ ] Auth, chat, thinking blocks, tool chips still work
- [ ] Stop button appears while streaming, kills agent
- [ ] Real token metrics shown in context indicator
- [ ] Markdown renders properly in responses
- [ ] Code blocks have copy buttons
- [ ] Cmd+Shift+O opens chat
- [ ] Right-click editor → "Send Selection to Odysseus"
- [ ] Star sessions in sidebar
- [ ] Session names auto-fill from first message
- [ ] Compact/Fork in sidebar row actions
- [ ] RAG / Incognito toggles in toolbar
- [ ] Memory panel shows memories
- [ ] Notes panel shows notes
- [ ] Search command searches across sessions
```
