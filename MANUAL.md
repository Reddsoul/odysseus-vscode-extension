# Odysseus VS Code Extension — User Manual

A step-by-step guide to using the Odysseus VS Code extension, which connects your editor to a self-hosted Odysseus AI server and provides an agent-capable chat panel directly inside VS Code.

---

## Table of Contents

1. [Installation & Prerequisites](#1-installation--prerequisites)
2. [Connecting to Your Odysseus Server](#2-connecting-to-your-odysseus-server)
3. [The Chat Panel](#3-the-chat-panel)
4. [Sending Messages](#4-sending-messages)
5. [Context Awareness](#5-context-awareness)
6. [Agent Mode vs Chat Mode](#6-agent-mode-vs-chat-mode)
7. [Plan Mode](#7-plan-mode)
8. [Tool Approval](#8-tool-approval)
9. [Sessions](#9-sessions)
10. [Workspace Rules](#10-workspace-rules)
11. [Memories & Notes](#11-memories--notes)
12. [Headless Task Runner](#12-headless-task-runner)
13. [Cron Scheduler](#13-cron-scheduler)
14. [Git Integration](#14-git-integration)
15. [Codebase Search](#15-codebase-search)
16. [Message Search](#16-message-search)
17. [Edit Review & Revert](#17-edit-review--revert)
18. [Research Mode](#18-research-mode)
19. [File Attachments](#19-file-attachments)
20. [Incognito Mode](#20-incognito-mode)
21. [Slash Commands](#21-slash-commands)
22. [Keybindings](#22-keybindings)
23. [Configuration Settings](#23-configuration-settings)
24. [URI Handler](#24-uri-handler)
25. [Troubleshooting](#25-troubleshooting)

---

## 1. Installation & Prerequisites

**Requirements:**

- VS Code 1.85 or later
- An Odysseus server running and reachable (default: `http://localhost:7860`)

**Install from the marketplace:**

1. Open the Extensions view (`Ctrl+Shift+X` / `Cmd+Shift+X`).
2. Search for **Odysseus**.
3. Click **Install**.

**Install from a `.vsix` file:**

```bash
code --install-extension odysseus-0.0.16.vsix
```

After installation the Odysseus sail icon appears in the Activity Bar on the left.

---

## 2. Connecting to Your Odysseus Server

The extension connects to `http://localhost:7860` by default.

**Change the server URL:**

1. Open Settings (`Ctrl+,` / `Cmd+,`).
2. Search for `odysseus.url`.
3. Enter your server address (e.g., `http://192.168.1.50:7860`).

**Authenticate (if required):**

Run `Odysseus: Configure` from the Command Palette and sign in. The token is stored in VS Code's secret storage and survives restarts.

---

## 3. The Chat Panel

### Opening the panel

| Method | Keys |
|---|---|
| Status bar click | Click **Odysseus** in the bottom-right status bar |
| Keyboard | `Cmd+Shift+O` (Mac) / `Ctrl+Shift+O` (Win/Linux) |
| Command Palette | `Odysseus: Open Chat` |

### Layout

- **Message area** — scrollable history with streaming responses, collapsible thinking blocks, and expandable tool call chips (showing tool name, command, exit code).
- **Input bar** — text area with toolbar buttons for Agent/Chat, Plan/Act, web search, bash, verbose, new chat, and send.
- **Context window meter** — color-coded bar (green < 50%, amber 50–80%, red > 80%) showing how full the context window is.
- **Status bar** — turns amber and shows `$(sync~spin) Odysseus: running (step N)` during active runs.

### Multiple panels

Run `Odysseus: Open New Chat Panel` to open a second independent panel. Each runs its own session.

---

## 4. Sending Messages

**Send:** press **Enter** (default) or **Ctrl+Enter** / **Cmd+Enter** if `odysseus.useCtrlEnterToSend` is on.  
**Newline:** **Shift+Enter** (always).

### Pre-populated context pills

Before sending, the input bar shows pills for:

- The **active file** (automatically attached).
- Any **editor selection** with line numbers.

### Sending a selection

1. Highlight code in the editor.
2. Right-click → **Send Selection to Odysseus**, or press `Alt+K` to insert an `@filename:start-end` reference into the chat input.

---

## 5. Context Awareness

Every message sent to the agent automatically includes:

| Context | How it's injected |
|---|---|
| Active file | Full content of the focused editor tab |
| Selection | Highlighted code with start/end line numbers |
| Diagnostics | Errors and warnings from the VS Code Problems panel |
| Git status | `git status --short` + `git diff --stat HEAD` |
| Workspace tree | File listing (up to 500 files, respects `.gitignore`) |
| Workspace rules | Contents of `.odysseusrules` if present |
| File restrictions | Patterns from `.odysseusignore` |
| **Relevant files** | Contents of files the index scores as relevant to your message |

Toggle git context and workspace tree via `odysseus.injectGitContext` and `odysseus.injectWorkspaceTree` in Settings.

### Workspace index

On startup the extension silently builds a local index of your workspace — file paths, languages, and symbol names (functions, classes, methods) extracted via VS Code's language servers. Before each message, the index is queried against your input to find the most relevant files, whose full contents are injected automatically so the agent doesn't need to read them manually via bash.

- **Automatic** — builds in the background at startup, no setup required.
- **Incremental** — file watchers keep the index up to date as you edit.
- **Persistent** — stored in VS Code's extension storage (not in your workspace). Rebuilt if older than 30 minutes.
- **Force rebuild** — Command Palette → `Odysseus: Rebuild Workspace Index`.

### @-mentions

Type `@` in the chat input to open a file picker. Selected file contents are injected into the message. `Alt+K` with a selection inserts `@filename:startLine-endLine`.

### `.odysseusignore`

Create `.odysseusignore` at the workspace root to list glob patterns the agent should never touch (e.g., `node_modules`, `.env`). The file is hot-reloaded on save.

---

## 6. Agent Mode vs Chat Mode

**Agent mode** (default): the AI can read/write files, run bash commands, do web searches, and execute Python. Toggle with the **Agent** button in the input bar or `odysseus.agentMode` in Settings.

**Chat mode**: plain LLM chat — no tools, no file access. Use for quick questions, explanations, or brainstorming.

---

## 7. Plan Mode

Plan mode lets the agent read and discuss code without making any changes.

- Toggle with the **📋 Plan / ⚡ Act** button in the input bar.
- State persists per workspace across VS Code restarts.
- In Plan mode the agent can open files, grep, and outline an approach — but cannot write files or run state-changing shell commands.
- Switch to **Act** mode when you're ready for the agent to apply changes.

---

## 8. Tool Approval

When `odysseus.requireApproval` is `true` (default), the chat shows an **approval card** whenever the agent is about to run a bash command, Python script, or file write.

**Card actions:**

- **Approve** — dismiss the card; the tool has already been dispatched by the backend and continues running.
- **Auto-approve** — skip approval cards for the rest of this session.
- **Reject** — call `stopChat()` on the server, halting the entire run immediately.

> **Note:** The approval card is a notification, not a blocking gate. The backend dispatches tools as part of a continuous server-side loop. "Reject" is the only action that actually stops execution.

Disable approval entirely: set `odysseus.requireApproval` to `false`.

---

## 9. Sessions

### Create

- Click **New chat** in the input bar, type `/new`, or run `Odysseus: New Session`.
- Sessions are auto-named from the first message.

### Switch

The Odysseus sidebar lists sessions grouped by Today / Yesterday / Last 7 days / Older. Click any entry to load it.

### Manage

Hover a session in the sidebar for actions:

| Action | Effect |
|---|---|
| Compact | Summarizes old messages, freeing context space |
| Fork | Creates an independent copy |
| Truncate | Drops messages past a chosen point |
| Star | Marks as important |
| Rename | Sets a custom name |
| Delete | Permanently removes the session |

### Session diff

Run `Odysseus: Show Session Diff` to pick a file the agent touched this session and open a side-by-side diff of original vs. current content.

### Resume a detached stream

If you close the panel mid-run, reopening the session reconnects to the in-progress stream automatically.

---

## 10. Workspace Rules

Persistent instructions injected into every conversation in a workspace.

**Create:**

```
Command Palette → Odysseus: Create .odysseusrules
```

This creates `.odysseusrules` at the workspace root. Edit it with your coding conventions, architecture constraints, and off-limits paths. Changes are picked up immediately (file-watched).

A **📜 badge** appears in the chat toolbar when rules are active.

**Example `.odysseusrules`:**

```
## Conventions
- All new files use ES modules (import/export), not CommonJS.
- No console.log in production code.

## Architecture
- API handlers live in src/api/, not inline in routes.

## Off-limits
- Never touch src/legacy/ — do not read or write these files.
```

---

## 11. Memories & Notes

### Memories panel (sidebar)

Persistent facts the agent injects into every session — preferences, project context, recurring instructions.

- **Create** a new memory.
- **Filter** by keyword.
- **Delete** stale entries.

### Notes panel (sidebar)

A lightweight notepad with TODO support.

- **Pin** notes to keep them at the top.
- **Check off** completed items.
- Notes persist across sessions.

### Schedules panel (sidebar)

Lists all cron-scheduled tasks with their cron expression, enabled/disabled state, and next run time. From here you can toggle, run immediately, or delete a schedule without opening the Command Palette.

---

## 12. Headless Task Runner

Run agent tasks in the background without an open chat panel.

**Start a task:**

1. Command Palette → `Odysseus: Run Headless Task`.
2. Enter a prompt (e.g., *"Add JSDoc to every exported function in src/"*).
3. The agent runs with full tools (bash, web search) in the background.
4. Output streams to **View → Output → Odysseus Tasks**.
5. On completion a toast notification appears with an **Open in Chat** button.

**View history:**

Command Palette → `Odysseus: Show Task History` — lists the last 50 tasks. Click any to open its session.

---

## 13. Cron Scheduler

Schedule recurring agent tasks on a cron expression.

**Create a schedule:**

1. Command Palette → `Odysseus: Schedule New Task`.
2. Enter a **name** and **prompt**.
3. Choose a preset or enter a custom 5-field cron expression:

| Preset | Cron |
|---|---|
| Every 15 min | `*/15 * * * *` |
| Every hour | `0 * * * *` |
| Daily at 9 am | `0 9 * * *` |
| Weekdays at 9 am | `0 9 * * 1-5` |
| Weekly Mon 9 am | `0 9 * * 1` |

**Manage schedules:**

- Command Palette → `Odysseus: Manage Schedules`
- Or use the **Schedules** panel in the sidebar (enable/disable toggle, run now, delete)

**Runtime details:**

- Polls every 60 seconds. Max 1-minute jitter on scheduled fires.
- Missed runs (e.g., VS Code was closed) execute on the first tick after restart.
- Timeout per task: `odysseus.schedulerTimeoutMinutes` (default 30 min).

---

## 14. Git Integration

### Automatic context

With `odysseus.injectGitContext` on, every message includes `git status --short` and `git diff --stat HEAD` so the agent knows what's changed.

### AI commit message

1. Stage your changes in the Source Control view.
2. Command Palette → `Odysseus: Generate Commit Message`.
3. The agent analyzes the staged diff (falls back to `git diff HEAD` if nothing staged) and produces a conventional commit message.
4. Result opens as an editable document; subject line is placed in the SCM input box.

### Checkpoints & revert

Before each agent run the extension snapshots all files it's about to touch. After the run:

- **Revert a single file** — click the Revert button in the chat for that file.
- **Revert entire run** — Command Palette → `Odysseus: Revert Agent Run`, pick the run, confirm.
- Checkpoints store up to 10 runs × 20 files.

---

## 15. Codebase Search

Grep the workspace and inject matches into the chat.

1. Command Palette → `Odysseus: Search Codebase`.
2. Enter a regex or keyword.
3. Up to 20 matches (file path, line number, content) are prefilled into the chat input.
4. Append your question and send.

---

## 16. Message Search

Search across all sessions on the server.

1. Command Palette → `Odysseus: Search Messages`.
2. Enter a query.
3. Matching excerpts appear in the chat panel; click any result to jump to that session.

---

## 17. Edit Review & Revert

**Before each run:** dirty buffers are auto-saved so the agent always reads current disk content.

**During a run:** the extension pre-snapshots files as soon as a write tool fires (captured from the `tool_start` SSE event before the write completes).

**After a run:**

| Option | Scope |
|---|---|
| **Revert** button in chat | Single file, current run |
| **Show Session Diff** | Any file touched this session — opens VS Code diff |
| **Revert Agent Run** | All files from any past run, bulk restore |

**Post-run diagnostics:** 2 seconds after a run completes the extension checks VS Code's diagnostic engine on written files. If TypeScript/language errors appear, a notice is posted in chat.

---

## 18. Research Mode

Deep web research with streaming sources.

- Click the **Research** button in the chat toolbar overflow menu.
- Enter a research question.
- The agent spawns a dedicated research session, performs web searches, and streams its report with numbered citations.
- Sources are listed at the end with clickable URLs.

---

## 19. File Attachments

Attach files to a message as additional context.

- Click the **attachment** button in the input bar.
- Select one or more files (images, PDFs, text).
- Files appear as pills above the input. Click the × on a pill to remove.
- Attachments are sent with the next message only; they are cleared after send.

---

## 20. Incognito Mode

Toggle via the **incognito** button in the toolbar overflow.

- Messages sent in incognito mode are not persisted to the server session.
- Useful for one-off queries you don't want in session history.
- Memory injection is also suppressed while incognito is on.

---

## 21. Slash Commands

Type `/` in the chat input to open the slash command menu:

| Command | Action |
|---|---|
| `/new` | Start a new session |
| `/compact` | Summarize old messages to free context space |
| `/truncate` | Keep only the last 10 messages in this session |
| `/verbose` | Toggle verbose mode (shows thinking blocks and full tool arguments) |
| `/clear` | Clear the chat display (session is kept on the server) |
| `/help` | List all slash commands |

---

## 22. Keybindings

| Shortcut | Action | When |
|---|---|---|
| `Cmd+Shift+O` / `Ctrl+Shift+O` | Open Chat | Always |
| `Alt+K` | Insert @-mention for current file/selection | Editor focused |

All extension commands are also available in the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`) — search **Odysseus**.

---

## 23. Configuration Settings

| Setting | Default | Description |
|---|---|---|
| `odysseus.url` | `http://localhost:7860` | Odysseus server URL |
| `odysseus.agentMode` | `true` | Enable agent tools by default |
| `odysseus.allowBash` | `true` | Allow bash execution in agent mode |
| `odysseus.allowWebSearch` | `true` | Allow web search in agent mode |
| `odysseus.maxIterations` | `30` | Max agent loop steps before auto-stop |
| `odysseus.requireApproval` | `true` | Show approval card before bash/file-write tools |
| `odysseus.injectGitContext` | `true` | Inject git status/diff into every message |
| `odysseus.injectWorkspaceTree` | `true` | Inject workspace file listing into every message |
| `odysseus.useCtrlEnterToSend` | `false` | Ctrl+Enter (not Enter) to send |
| `odysseus.schedulerTimeoutMinutes` | `30` | Max runtime for scheduled tasks |
| `odysseus.promptToCommit` | `false` | Offer commit message generation after agent file changes |

---

## 24. URI Handler

Open the chat with a pre-filled prompt from any external tool or script:

```
vscode://JoseAlma.odysseus-vscode-extension/open?prompt=<URL-encoded+prompt>
```

Example (shell):

```bash
open "vscode://JoseAlma.odysseus-vscode-extension/open?prompt=Review%20the%20auth%20module"
```

This opens VS Code, focuses the Odysseus panel, and pre-fills the chat input with your prompt.

---

## 25. Troubleshooting

**Cannot connect to server**
- Confirm `odysseus.url` is reachable from your machine.
- Check the server container/process is running.
- If the server is on NAS/SMB, the backend container may not be able to reach `/Volumes/` paths — run the backend natively or from a local path.

**Agent won't run tools**
- Check Agent mode is on in the input bar.
- Confirm `odysseus.agentMode` is `true` in Settings.
- If in Plan mode, switch to Act mode.

**Run won't stop**
- Run `Odysseus: Cancel Active Run` from the Command Palette.
- The status bar button also switches to a Cancel action during active runs.

**Approval card appears but nothing happens on Approve**
- This is expected behavior — "Approve" dismisses the card. The tool was already dispatched by the backend. Use "Reject" to actually stop execution.

**Git context missing**
- Ensure the workspace is a git repository with at least one commit.
- Confirm `git` is available in your PATH.
- Toggle `odysseus.injectGitContext` off and back on to refresh.

**Scheduled tasks not firing**
- Verify the schedule is enabled in the Schedules sidebar panel.
- The scheduler checks every 60 seconds — there may be up to a 1-minute delay.
- Check **View → Output → Odysseus Tasks** for error output.
- Confirm the server is reachable; scheduled tasks use the headless task runner.

**Revert didn't restore the file**
- Checkpoints are captured at run start for files in the active editor and on `tool_start` events. Files the agent wrote without a detectable `tool_start` event may not have a snapshot.
- Only the last 10 runs × 20 files are kept; older checkpoints are discarded.

**Context window is full (red meter)**
- Run `/compact` to summarize old messages.
- Run `/truncate` to drop earlier turns.
- Start a new session with `/new`.

**Workspace index not picking up relevant files**
- The index builds once at startup and stays warm via file watchers. If you opened a large new project, run `Odysseus: Rebuild Workspace Index` from the Command Palette to force a fresh full scan.
- Binary files, files over 50 KB, and files matching standard exclusions (`node_modules`, `dist`, `*.log`, etc.) are skipped intentionally.
- If your language server isn't running yet at startup, symbol extraction falls back to path-only matching. Restart VS Code (which re-triggers indexing) once the language server is active.
