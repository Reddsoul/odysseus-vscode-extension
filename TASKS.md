# Odysseus VSCode Extension — Feature Implementation Sprint

## Context

You are implementing features on the **Odysseus VSCode Extension** — a VS Code extension that connects to a self-hosted Odysseus AI server (similar to Open WebUI) running locally at a configurable URL (default `http://localhost:7860`). The extension proxies chat through the Odysseus backend which handles LLM calls, tool execution (bash, web search, file read/write), and streaming.

This is NOT the official Claude Code extension. Do not reference Claude Code internals. Everything must be implemented within the VS Code extension API + the Odysseus HTTP backend API.

## Repository Layout

```
src/
  extension.ts          — activation, command registration
  ChatPanel.ts          — main chat webview panel (WebviewPanel, Beside column)
  OdysseusViewProvider.ts — sidebar webview (session history, auth states)
  api/
    client.ts           — OdysseusClient (HTTP, auth, sessions, documents)
    streaming.ts        — SSE stream parser, OdysseyEvent types
  context/
    fileContext.ts      — active file/selection context, buildApiMessage
  sync/
    docSync.ts          — maps local files to Odysseus document IDs
```

**Build**: `npm run compile` (tsc). Extension host reloads with `F5` in VS Code extension dev host. There are no automated tests — verify manually by running the extension host.

**Key constraints**:
- All webview JS is inlined in `buildHtml()` template strings — no separate bundle
- CSP: `default-src 'none'; style-src 'nonce-...'; script-src 'nonce-...'` — no external resources
- Backend is the Odysseus server — extension cannot make LLM calls directly
- When features require backend API endpoints that may not exist, note clearly and implement the frontend assuming a documented contract, then test against the real server

---

## Regression Baseline

Before implementing ANY task, run `npm run compile` to confirm zero errors. After each task:
1. Run `npm run compile` — must pass with zero errors
2. Launch extension host (`F5`) and manually verify:
   - Auth flow still works (login screen appears if no token)
   - Chat panel opens, sends a message, streams a response
   - Session history sidebar loads and sessions are clickable
   - Context pills appear for active file and selection
   - Tool calls render with chips + output
   - Thinking blocks render and are collapsible
   - Model picker opens and switches models
   - Verbose mode toggle works

Do not proceed to the next task if any regression is found.

---

## Task 1 — Fix: retainContextWhenHidden on sidebar

**Problem**: `OdysseusViewProvider` registered with `retainContextWhenHidden: false`. Every time the sidebar hides (user clicks another activity bar icon), the webview is destroyed and rebuilt — losing scroll position, re-fetching sessions, flickering.

**Implementation**:
In `extension.ts`, change the `registerWebviewViewProvider` call:
```ts
{ webviewOptions: { retainContextWhenHidden: true } }
```

**Verify**: Open sidebar → load sessions → click Explorer icon → click Odysseus icon back. Sessions should still be there without a reload spinner.

---

## Task 2 — Fix: Ctrl+Enter to send (configurable)

**Problem**: Only `Enter` sends. Shift+Enter adds newline. No option for Ctrl+Enter.

**Implementation**:
1. Add VS Code setting `odysseus.useCtrlEnterToSend` (boolean, default `false`) in `package.json` contributes.configuration.
2. In `ChatPanel.ts`, read the setting in `init()` and pass it as a JS variable to the webview via `buildHtml(state, initialModel, useCtrlEnter)`.
3. In the webview script, conditionally change the keydown handler:
   - If `useCtrlEnter`: send on `Ctrl+Enter` or `Cmd+Enter`, Shift+Enter adds newline, plain Enter adds newline.
   - If not: current behavior (Enter sends, Shift+Enter newline).

**Verify**: Toggle the setting in VS Code settings UI. Confirm behavior changes without reload (setting read at init; document that a panel restart picks it up).

---

## Task 3 — Autosave files before agent reads them

**Problem**: If the user has unsaved edits in the editor when the agent runs, the agent reads stale disk content.

**Implementation**:
In `ChatPanel.handleSend()`, before calling `streamChat`, save all dirty documents in the workspace:
```ts
await vscode.workspace.saveAll(false); // false = don't include untitled
```

**Verify**: Open a file, make an unsaved edit, ask the agent "what does this file contain?" — confirm it sees the latest unsaved content (the save writes to disk, agent reads disk).

---

## Task 4 — VS Code diagnostics injected into context

**Problem**: The agent is blind to type errors, lint errors shown in VS Code's Problems panel. Claude Code's IDE MCP exposes these; we need to inject them without MCP.

**Implementation**:
In `fileContext.ts`, add a new function:
```ts
export function getDiagnosticsContext(filePath?: string): string | null
```
- Uses `vscode.languages.getDiagnostics()` — if `filePath` given, scoped to that URI; otherwise all workspace diagnostics.
- Returns a formatted string listing file, line, severity, message. Cap at 50 entries.
- Returns `null` if no diagnostics.

In `buildApiMessage()`, call `getDiagnosticsContext(fileCtx?.filePath ?? undefined)` and if non-null, append a `<vscode_diagnostics>` block before `</vscode_workspace>`.

In the instructions block, add: "The vscode_diagnostics above are the current errors and warnings from the VS Code Problems panel for this file."

**Verify**: Introduce a TypeScript type error in a file → open chat → ask "what errors are in this file?" → confirm agent knows about the error without being told explicitly.

---

## Task 5 — Better sendSelection: insert @file#line reference

**Problem**: `prefillSelection` event just sets the textarea to "Explain this X code:\n" — loses the file+line info and forces the user to retype. Claude Code inserts `@file.ts#5-10` style references.

**Implementation**:
Change `sendSelection()` in `ChatPanel.ts` to send a different message to the webview:
```ts
this.postMessage({
  type: "prefillSelection",
  filePath: sel.filePath ?? "",
  startLine: sel.startLine,
  endLine: sel.endLine,
  language: sel.language,
  text: sel.text,
});
```
Also update `SelectionContext` in `fileContext.ts` to include `filePath` (add `filePath: string` field, populate from `editor.document.fileName`).

In the webview, handle `prefillSelection` by inserting a reference into the textarea like:
```
@<basename>:<startLine>-<endLine>
```
where basename is the last path segment. Append to any existing text rather than replacing. Focus the textarea and position cursor at end.

**Verify**: Select 3 lines in a file → run `odysseus.sendSelection` → panel opens → textarea contains the file reference on a new line.

---

## Task 6 — @-mention file picker in the chat input

**Problem**: No way to reference specific files in a message. Users must hope the active file pill covers their needs.

**Implementation** (extension-side only, no backend changes):

**Part A — Trigger detection**:
In the webview textarea keydown/input handler, detect when the user types `@`:
- After `@` is typed (at word boundary — start of input or preceded by whitespace), open a file picker overlay.
- Track the `@query` as the user types more chars.

**Part B — File picker overlay**:
Add a floating div `.at-picker` above the textarea (positioned via CSS `position: absolute; bottom: calc(100% + 4px)`). Style it like the model picker menu.

On `@` trigger, post `{ type: 'requestFiles', query: '' }` to the extension.

In `ChatPanel.ts`, handle `requestFiles`:
```ts
case "requestFiles": await this.handleRequestFiles(String(msg.query ?? "")); break;
```

`handleRequestFiles` uses `vscode.workspace.findFiles('**/*', '**/node_modules/**', 30)` filtered by the query string (basename contains query, case-insensitive). Returns `{ type: 'filesResult', files: [{name, path, relativePath}] }`.

**Part C — Selection and injection**:
When user clicks/keyboards a result, replace `@<query>` in the textarea with `@<relativePath>` and close the picker. Close picker on Escape or click-outside.

**Part D — Context resolution**:
In `ChatPanel.handleSend()`, before calling `buildApiMessage`, parse the message text for `@<relativePath>` tokens. For each found:
- Read the file content (first 10,000 chars, truncated if larger).
- Append a `<referenced_file path="...">...</referenced_file>` block to the API message.
- Leave the display message unchanged (user sees `@file.ts`, API gets the content injected).

**Verify**:
- Type `@` in chat → picker appears with workspace files
- Type more chars → list filters
- Click a file → `@filename.ts` inserted
- Send message → check that the API message (log it) includes file contents

---

## Task 7 — Keyboard shortcut: Alt+K inserts @-mention for current file+selection

**Problem**: No keyboard shortcut to quickly reference the active file and selected lines.

**Implementation**:
1. Register keybinding in `package.json`:
```json
{
  "command": "odysseus.insertAtMention",
  "key": "alt+k",
  "mac": "alt+k",
  "when": "editorFocus"
}
```
2. Register the command in `extension.ts`:
```ts
vscode.commands.registerCommand("odysseus.insertAtMention", () => {
  const panel = ChatPanel.getCurrent();
  if (!panel) { return; }
  panel.insertAtMention();
});
```
3. In `ChatPanel.ts`, add `insertAtMention()`:
   - Gets active file + selection
   - Posts `{ type: "insertAtMention", ref: "@basename.ts:5-10" }` to webview (or just `@basename.ts` if no selection)
4. In webview, handle `insertAtMention`: append the ref to current textarea content (with a leading space if textarea isn't empty), focus, move cursor to end.

**Verify**: Open a file, select 5 lines, press Alt+K → chat panel opens (or focuses) → `@filename.ts:5-10` appears in textarea.

---

## Task 8 — Session rename and delete

**Problem**: Sessions can't be renamed or deleted from the sidebar. History accumulates with useless default names.

**Implementation**:
Check if Odysseus backend has `PATCH /api/session/:id` (name field) and `DELETE /api/session/:id`. If not, add notes — implement assuming they exist.

**Backend contract assumed**:
- `PATCH /api/session/:id` with `{ name: "new name" }` → updates name
- `DELETE /api/session/:id` → removes session

In `client.ts`, add:
```ts
async renameSession(id: string, name: string): Promise<void>
async deleteSession(id: string): Promise<void>
```

In `OdysseusViewProvider.ts`, update `buildHtml` for the ready state. Each session row gets hover-revealed action buttons (rename ✏, delete 🗑). Use CSS `:hover` on `.session-row` to show `.session-actions` buttons. No inline edit — rename triggers a `vscode.window.showInputBox`.

Handle new message types `renameSession` and `deleteSession` in `handleMessage`. For delete: ask `vscode.window.showQuickPick(['Yes, delete', 'Cancel'])` as confirmation, then call client, then refresh sessions. For rename: call `showInputBox`, then client, then refresh.

**Verify**: Right-hover a session row → rename and delete buttons appear → rename updates name in list → delete prompts confirmation then removes from list.

---

## Task 9 — History message replay when switching sessions

**Problem**: Switching sessions via sidebar clears the chat view instead of showing past messages. User loses context.

**Implementation**:
Check if Odysseus backend has a `GET /api/session/:id/messages` or similar endpoint. If yes, use it. If not, implement a fallback.

**If backend has message history endpoint**:
Add to `client.ts`:
```ts
async getSessionMessages(id: string): Promise<Array<{role: string, content: string, created_at?: string}>>
```

In `ChatPanel.loadSession()`, after clearing messages, fetch history and post `{ type: "loadHistory", messages: [...] }` to webview.

In webview, handle `loadHistory`: for each message render a `.msg.user` or `.msg.assistant` div with the content. Scroll to bottom.

**If backend has no history endpoint**:
Keep current behavior (clear on switch) but add a `{ type: "sessionSwitched", sessionName: "..." }` message to webview that renders a gray divider: "— switched to: Session Name —" so the user knows what happened.

Check the backend by calling `GET /api/session/:id/messages` from `client.ts` and logging the result. Implement whichever path applies.

**Verify**: Start a conversation, open sidebar, click a different session then back → should see conversation history if backend supports it, or see the divider if not.

---

## Task 10 — Context window usage indicator

**Problem**: No indication of how much context has been used. Users don't know when to start a new session.

**Implementation**:
Check if Odysseus backend returns token usage in the stream events (look for fields like `input_tokens`, `usage`, `context_length` in the SSE events currently ignored by `parseEvent` in `streaming.ts`).

**If backend emits usage events**:
- Extend `OdysseyEvent` union with `{ type: "usage"; input_tokens: number; total_context: number }` or similar.
- In `parseEvent`, detect and return the usage event.
- In webview, maintain `let usedTokens = 0; let maxTokens = 200000;`. On usage event, update.
- Add a thin progress bar or text indicator in the chat header: "Context: 12k / 200k" or a progress bar under the input bar.

**If backend does not emit usage**:
- Add a character-count heuristic indicator in the chat header: count all rendered message text lengths ÷ 4 ≈ tokens. Show "~Xk tokens used" in the chat header (already exists as `.chat-header` div, currently only shown in verbose mode).
- Make the context indicator always visible (remove the `body.verbose` condition on `.chat-header`).

Implement both paths. The heuristic is always available; upgrade to real data if backend exposes it.

**Verify**: Send several messages → context indicator updates after each exchange.

---

## Task 11 — Edit approval diff viewer

**Problem**: The agent writes files directly to disk via bash. No preview, no accept/reject.

**Implementation** (post-write diff + optional revert — doesn't require stream pausing):

**Part A — Capture file state before agent runs**:
In `ChatPanel.handleSend()`, before `streamChat`, snapshot the content of the active file (and any @-mentioned files if Task 6 is done):
```ts
const preEditSnapshots = new Map<string, string>(); // path → content before
if (fileCtx) {
  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(fileCtx.filePath));
    preEditSnapshots.set(fileCtx.filePath, Buffer.from(bytes).toString("utf-8"));
  } catch {}
}
```

**Part B — Track written paths** (already done via `parseWrittenPath`).

**Part C — After agent completes, show diff for each written file**:
After the stream ends (in the `try/finally` after `await streamChat`), for each path in `writtenPaths`:
1. Read the new content from disk.
2. If path is in `preEditSnapshots`, open a VS Code diff editor:
   ```ts
   const originalUri = vscode.Uri.parse(`odysseus-original:${path}`);
   // Register a TextDocumentContentProvider for 'odysseus-original' scheme
   // that serves the pre-edit content from preEditSnapshots
   await vscode.commands.executeCommand(
     "vscode.diff",
     originalUri,
     vscode.Uri.file(path),
     `Odysseus: ${basename} (original ↔ modified)`,
     { preview: true }
   );
   ```
3. Post `{ type: "editProposed", path }` to webview which renders a small action bar in the chat:  
   `"📄 filename.ts was modified — [View diff] [Revert]"`
   - "View diff" re-runs the vscode.diff command
   - "Revert" posts `{ type: "revertEdit", path }` to extension which writes the original content back using `vscode.workspace.fs.writeFile`

**Part D — Register the content provider** in `extension.ts`:
```ts
vscode.workspace.registerTextDocumentContentProvider("odysseus-original", {
  provideTextDocumentContent(uri) {
    return ChatPanel.getCurrent()?.getPreEditSnapshot(uri.path) ?? "";
  }
});
```
Add `getPreEditSnapshot(path: string): string | undefined` to `ChatPanel`.

**Verify**:
- Ask agent to modify a file → diff editor opens automatically showing changes
- "Revert" button in chat restores original content
- Files that were created (not modified) don't show a diff (no pre-edit snapshot)

---

## Task 12 — Multiple conversation tabs (remove singleton)

**Problem**: `ChatPanel.instance` is a singleton. Opening a second chat kills the first.

**Implementation**:

Remove the singleton pattern. Change to a Set of instances:
```ts
private static instances = new Set<ChatPanel>();
public static getCurrent(): ChatPanel | undefined {
  // Return the most recently focused instance
  return ChatPanel._lastFocused;
}
private static _lastFocused?: ChatPanel;
```

In `createOrShow`:
- If `sessionId` provided and an existing instance has that session, focus it and return it.
- Otherwise create a new panel (don't reveal an existing one).

On panel focus events (`panel.onDidChangeViewState`), update `ChatPanel._lastFocused`.

On dispose, remove from `instances` Set.

Update all callers of `ChatPanel.getCurrent()` to handle `undefined` gracefully (they already do in most cases).

Update `ChatPanel.onDidClose` callback to only refresh sidebar, not assume singleton.

Add a new command `odysseus.openNewChat` that always creates a fresh panel even if one exists. Register it in `extension.ts` and add to `package.json` commands.

**Verify**:
- Open chat → send message → run `odysseus.openNewChat` command → second panel opens independently
- Closing one panel doesn't affect the other
- Sidebar session clicks open in a new panel if the session isn't already open

---

## Task 13 — Slash command menu (/)

**Problem**: No slash commands. Missing `/compact`, `/new`, `/verbose`, `/help` at minimum.

**Implementation** (extension-side slash commands only — no backend slash commands):

In the webview, detect `/` typed at the start of the input (or after only whitespace). Show a `.slash-menu` overlay (similar to `.at-picker` from Task 6).

Available commands (define as a static array):
```js
const SLASH_COMMANDS = [
  { cmd: "/new",     desc: "Start a new session" },
  { cmd: "/compact", desc: "Summarize conversation to free context (note: requires backend support)" },
  { cmd: "/verbose", desc: "Toggle verbose mode (thinking blocks + tool args)" },
  { cmd: "/clear",   desc: "Clear the chat display (session kept on server)" },
  { cmd: "/help",    desc: "Show available slash commands" },
];
```

When user selects a command:
- `/new` → post `{ type: "newSession" }` (same as new chat button)
- `/verbose` → toggle verbose mode
- `/clear` → post `{ type: "clearDisplay" }` which clears the messages div without touching the server session
- `/help` → inject a help message into the chat display (not sent to AI)
- `/compact` → post `{ type: "compact" }` to extension → extension posts a system message to Odysseus asking it to summarize the conversation (approximate: send "Please summarize our conversation so far in 2-3 sentences to compact context." as a regular message)

Filter the list as the user types after `/`.

**Verify**:
- Type `/` → slash menu appears
- Type `/verb` → filters to `/verbose`
- Select `/verbose` → verbose mode toggles
- Select `/new` → new session starts
- Escape → menu closes

---

## Task 14 — URI handler to open chat from external tools

**Problem**: No way to open the chat from a shell alias, script, or browser.

**Implementation**:
In `package.json`, add:
```json
"contributes": {
  "uriHandlers": []
}
```
Actually URI handlers don't need declaration in package.json for VS Code — register in extension.ts:

```ts
context.subscriptions.push(
  vscode.window.registerUriHandler({
    handleUri(uri: vscode.Uri) {
      const params = new URLSearchParams(uri.query);
      const prompt = params.get("prompt") ?? "";
      const panel = ChatPanel.createOrShow(context);
      if (prompt) {
        panel.prefillPrompt(decodeURIComponent(prompt));
      }
    },
  })
);
```

Add `prefillPrompt(text: string)` to `ChatPanel` which posts `{ type: "prefillPrompt", text }` to the webview. Handle in webview: set textarea value to text, focus, auto-resize.

The URI is: `vscode://JoseAlma.odysseus-vscode-extension/open?prompt=review%20my%20changes`

Document the URI scheme in the readme.

**Verify**:
Open terminal, run:
```bash
open "vscode://JoseAlma.odysseus-vscode-extension/open?prompt=hello%20from%20terminal"
```
Chat panel should open with "hello from terminal" pre-filled.

---

## Task 15 — gitignore-aware file listing in context

**Problem**: `fileContext.ts:86-89` lists top-level files with a naive filter (no `.`, not `node_modules`, not `__pycache__`). Doesn't respect `.gitignore`.

**Implementation**:
Replace the manual `readdirSync` with `vscode.workspace.findFiles`:
```ts
const pattern = new vscode.RelativePattern(workspaceRoot, "**/*");
const files = await vscode.workspace.findFiles(pattern, "**/node_modules/**", 60);
```
`vscode.workspace.findFiles` respects `.gitignore` when `files.exclude` is configured in VS Code and when the `respectGitIgnore` option is set.

Since `buildApiMessage` is currently synchronous but `findFiles` is async, change `buildApiMessage` to `async buildApiMessage(...)` and update all call sites to `await` it.

Update the file list section to show relative paths (strip workspace root prefix) rather than just basenames, so the model can navigate.

**Verify**:
Create a `.gitignore` with `dist/` → add files to `dist/` → open chat → check the `<vscode_workspace>` block in the logged API message doesn't include `dist/` files.

---

## Final Regression Checklist

After all tasks are complete, run through this full checklist manually:

**Auth & Connection**
- [ ] Fresh install (no stored token) → shows login screen
- [ ] Login with valid credentials → transitions to chat
- [ ] Login with invalid credentials → shows error
- [ ] TOTP 2FA flow works
- [ ] Sign out from sidebar footer → back to login
- [ ] Server URL change → reconnects
- [ ] Server unreachable → shows disconnected screen with retry

**Chat Core**
- [ ] Type message, press Enter → sends, streams response
- [ ] Shift+Enter → adds newline (does not send)
- [ ] Stream renders deltas in real time
- [ ] Thinking blocks render and collapse/expand
- [ ] Tool call chips render with running/success/error states
- [ ] Tool output expands on click
- [ ] Verbose mode shows tool args
- [ ] Ctrl+O expands/collapses all thinking blocks
- [ ] Status messages cycle while waiting

**Context**
- [ ] Active file pill shows current file
- [ ] Clicking another file updates the pill
- [ ] Selection pill appears when text selected
- [ ] Dismiss (×) on pill → excluded from next send
- [ ] Selection pill clears after send

**Sessions**
- [ ] New session button starts fresh chat
- [ ] Sidebar shows session list grouped by time
- [ ] Clicking session in sidebar opens/focuses chat panel
- [ ] Session persists across panel close+reopen (workspaceState)
- [ ] Search in sidebar filters sessions

**Models**
- [ ] Model picker shows available models
- [ ] Searching filters models
- [ ] Selecting model changes current model, updates session

**Agent**
- [ ] Agent mode: bash tool executes
- [ ] Chat mode: no tool calls
- [ ] Web search toggle works
- [ ] Files written by agent refresh in VS Code editor

**New Features (from tasks above)**
- [ ] Task 1: Sidebar doesn't flicker on hide/show
- [ ] Task 2: Ctrl+Enter setting (if enabled) sends; Enter adds newline
- [ ] Task 3: Unsaved edits are saved before agent runs
- [ ] Task 4: Diagnostics appear in context
- [ ] Task 5: sendSelection inserts `@file:line` reference
- [ ] Task 6: @ triggers file picker, selection injects content
- [ ] Task 7: Alt+K inserts @-mention from editor
- [ ] Task 8: Rename/delete sessions works
- [ ] Task 9: Switching sessions shows history or divider
- [ ] Task 10: Context indicator visible and updates
- [ ] Task 11: Diff opens after agent modifies file; revert works
- [ ] Task 12: Multiple panels can coexist independently
- [ ] Task 13: Slash menu appears, commands execute
- [ ] Task 14: URI handler opens chat with prefilled prompt
- [ ] Task 15: File listing respects .gitignore

---

## Notes

- Tasks 1–5 and 13–15 are purely extension-side — no backend changes needed.
- Tasks 6, 7, 10: verify backend response shapes before implementing. Log API responses.
- Task 11 (diff viewer): implement the revert path even if diff opens empty (no pre-edit snapshot) — don't crash.
- Task 12 (multi-panel): test for memory leaks — dispose() must clean up all listeners.
- If any task reveals a missing backend API, document the assumed contract in a `BACKEND_CONTRACTS.md` file and implement the frontend anyway with a graceful fallback.
- `npm run compile` must pass with zero TypeScript errors after each task.
