# Odysseus AI Helper

VS Code extension for a self-hosted Odysseus AI assistant. Connects to your local Odysseus server and gives you an agent-capable chat panel directly inside VS Code.

[Github](https://github.com/Reddsoul/odysseus-vscode-extension)

For issues, gripes and whishlist items, add them to Gripesheet.md with your name and the context of it. 

## Requirements

- Odysseus server running (default `http://localhost:7860`)
- VS Code 1.85+

## Getting Started

1. Start your Odysseus server.
2. Open the Odysseus panel from the Activity Bar (sail icon).
3. Sign in with your Odysseus credentials.
4. Start chatting — the agent can read files, run bash, search the web, and write to disk.

## Features

### Chat Panel
- Streaming responses with real-time token output
- Collapsible thinking blocks (extended reasoning)
- Tool call chips showing bash, web search, file read/write with expandable output
- Agent mode (tools enabled) / Chat mode (plain LLM) toggle
- Web search and bash toggles per-message
- Verbose mode — reveals tool input args and reasoning step counts
- Rotating status messages while waiting (the important ones)
- File attachments — attach images, PDFs, or text files to any message
- Research mode — deep web research with streaming progress and numbered sources
- Incognito mode — sends messages without saving to session history
- Detached stream resume — reconnects to an in-progress agent run if the panel is closed and reopened

### Plan Mode
- **Plan / Act toggle** in the chat input bar — in Plan mode the agent reads files and discusses code but is blocked from writing files or running state-changing bash commands. Switch to Act mode to let it execute.
- Plan mode state persists per workspace.

### Tool Approval
- `odysseus.requireApproval` setting (default on) — bash and python tool calls show an approval card before execution.
- Approve once, reject (stops the run), or **Auto-approve** for the rest of the session.

### Workspace Rules
- Drop a `.odysseusrules` file in your project root to give the agent persistent per-workspace instructions (coding conventions, architecture notes, off-limits paths, etc.).
- Rules are injected into every conversation in that workspace and auto-reloaded on change.
- `Odysseus: Create Workspace Rules File` command scaffolds the file with a template.
- A green badge appears in the chat UI whenever rules are active.

### Memories
- **Sidebar Memories panel** — create, filter, and delete AI memories that persist across sessions. Memories are injected into every chat to help the agent remember your preferences, project context, and important details.

### Notes
- **Sidebar Notes panel** — persistent notes and TODO lists with pinning and completion toggles. Notes survive across sessions and workspace reloads.

### Context Awareness
- Active file pill — automatically injects the open file into every message
- Selection pill — injects highlighted code with line numbers
- VS Code diagnostics injection — errors and warnings from the Problems panel sent as context
- `@file` mentions — type `@` to open a fuzzy file picker; selected file contents are injected into the API message
- `Alt+K` — inserts an `@filename:startLine-endLine` reference from your current editor selection
- `odysseus.sendSelection` command — appends a `@file:line` reference to the chat input
- Workspace file listing (gitignore-aware) sent as context on every message
- **Git context injection** — `git status` and `git diff --stat HEAD` automatically included as context (toggle with `odysseus.injectGitContext`)
- **Workspace index** — on startup the extension silently indexes workspace symbols (functions, classes, methods) and injects the most relevant files' contents automatically with every message. Updated incrementally as files change. Force rebuild with `Odysseus: Rebuild Workspace Index`.

### Message History
- **Edit & delete past messages** — hover any message in the conversation history to reveal edit and delete buttons. Edit a message to re-send it to the agent; delete to remove it.
- Message history replay when switching sessions (falls back to a divider if backend has no history endpoint)

### Edit Review
- Pre-send autosave — dirty buffers are saved before the agent runs so it reads fresh disk content
- Post-write diff viewer — when the agent modifies a file, a VS Code diff opens automatically showing original vs modified
- Revert button — inline "Revert" action in the chat restores the pre-edit snapshot without touching the conversation
- `Odysseus: Show Session Diff` command — pick any file touched this session and open its diff

### Checkpoint & Multi-file Revert
- Every agent run snapshots all files it touches (up to 20 files, last 10 runs kept).
- `Odysseus: Revert Agent Run` (`odysseus.revertSession`) — pick any past run from a QuickPick list and restore all its files to their pre-run state in one step.

### Headless Task Runner
- `Odysseus: Run Task` (`odysseus.runTask`) — describe a task; the agent runs it in the background in full agent mode (bash + web search enabled) with output streamed to the **Odysseus Tasks** output channel.
- Status bar spins during execution; a notification appears on completion with an **Open in Chat** button to load the task's session.
- Task history persisted (last 50 runs) — `Odysseus: Show Task History` opens a QuickPick to jump to any past task's session.
- Configurable via `odysseus.allowBash`, `odysseus.allowWebSearch`, and `odysseus.maxIterations`.

### Cron Scheduler
- `Odysseus: Schedule New Task` (`odysseus.scheduleTask`) — create a named, cron-scheduled recurring task. Choose from presets (every 15 min / hourly / daily 9 am / weekdays 9 am / weekly Monday 9 am) or enter a custom 5-field cron expression.
- `Odysseus: Show Schedules` (`odysseus.showSchedules`) — list all schedules; enable/disable, run immediately, or delete from a single QuickPick.
- Built-in cron parser — no external dependencies.
- Schedules poll every 60 seconds; a toast notifies when a task fires with a **Show Output** shortcut.
- Per-schedule timeout defaults to `odysseus.schedulerTimeoutMinutes` (default 30).

### AI Commit Message Generator
- `Odysseus: Generate Commit Message` (`odysseus.generateCommitMessage`) — sends the staged diff (or `git diff HEAD` if nothing is staged) to the agent, which returns a conventional commit message.
- Result opens as an editable `git-commit` document; the subject line is also written to the VS Code SCM input box.

### Codebase Search
- `Odysseus: Search Codebase` (`odysseus.searchCodebase`) — regex or keyword search across workspace files; results (up to 20 matches with file and line numbers) are prefilled into the chat input.
- `Odysseus: Search Messages` (`odysseus.searchMessages`) — full-text search across all sessions.

### Session Management
- Session history sidebar with search, grouped by Today / Yesterday / Last 7 days / Older
- **Session operations** — hover a session in the sidebar to compact, fork, truncate, star (mark as important), rename, or delete. Compacting summarizes old messages; forking creates an independent copy.
- Rename and delete sessions (hover a session to reveal actions)
- Message history replay when switching sessions (falls back to a divider if backend has no history endpoint)
- Multiple chat panels — `Odysseus: Open New Chat Panel` opens an independent conversation
- Session persisted per workspace via VS Code workspace state
- Sessions are auto-named from the first message

### Input
- Slash commands: `/new`, `/clear`, `/verbose`, `/compact`, `/help`
- `@` file picker with keyboard navigation (Arrow keys, Enter, Escape)
- Model picker — searchable dropdown, switches model mid-session
- `Ctrl+Enter` to send (optional, off by default — set `odysseus.useCtrlEnterToSend`)
- `Shift+Enter` for newline
- Context window usage indicator (character-count heuristic, shown after first exchange)

### Integration
- URI handler — open a pre-filled chat from any tool:
  ```
  vscode://JoseAlma.odysseus-vscode-extension/open?prompt=<encoded prompt>
  ```

## Configuration

| Setting | Default | Description |
|---|---|---|
| `odysseus.url` | `http://localhost:7860` | Odysseus server URL |
| `odysseus.agentMode` | `true` | Enable agent tools by default |
| `odysseus.allowBash` | `true` | Allow bash tool in agent/task mode |
| `odysseus.allowWebSearch` | `true` | Allow web search tool |
| `odysseus.maxIterations` | `30` | Max agent steps per run before auto-stop |
| `odysseus.requireApproval` | `true` | Show approval card before bash/python tool calls |
| `odysseus.injectGitContext` | `true` | Include git status/diff in every message |
| `odysseus.injectWorkspaceTree` | `true` | Include workspace file tree in every message |
| `odysseus.schedulerTimeoutMinutes` | `30` | Default timeout for scheduled tasks |
| `odysseus.useCtrlEnterToSend` | `false` | Use Ctrl+Enter to send (Enter adds newline) |
