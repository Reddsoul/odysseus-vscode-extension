# Odysseus AI Helper

VS Code extension for [Odysseus](https://github.com/your-repo/odysseus) — a self-hosted AI assistant. Connects to your local Odysseus server and gives you an agent-capable chat panel directly inside VS Code.

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

### Context Awareness
- Active file pill — automatically injects the open file into every message
- Selection pill — injects highlighted code with line numbers
- VS Code diagnostics injection — errors and warnings from the Problems panel sent as context
- `@file` mentions — type `@` to open a fuzzy file picker; selected file contents are injected into the API message
- `Alt+K` — inserts an `@filename:startLine-endLine` reference from your current editor selection
- `odysseus.sendSelection` command — appends a `@file:line` reference to the chat input
- Workspace file listing (gitignore-aware) sent as context on every message

### Edit Review
- Pre-send autosave — dirty buffers are saved before the agent runs so it reads fresh disk content
- Post-write diff viewer — when the agent modifies a file, a VS Code diff opens automatically showing original vs modified
- Revert button — inline "Revert" action in the chat restores the pre-edit snapshot without touching the conversation

### Session Management
- Session history sidebar with search, grouped by Today / Yesterday / Last 7 days / Older
- Rename and delete sessions (hover a session to reveal actions)
- Message history replay when switching sessions (falls back to a divider if backend has no history endpoint)
- Multiple chat panels — `Odysseus: Open New Chat Panel` opens an independent conversation
- Session persisted per workspace via VS Code workspace state

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
  open "vscode://JoseAlma.odysseus-vscode-extension/open?prompt=review%20my%20changes"
  ```
- `Alt+K` keybinding inserts `@file:line` reference when editor is focused
- Sidebar retains state when hidden (no flicker/reload on Activity Bar switch)

## Commands

| Command | Description |
|---|---|
| `Odysseus: Open Chat` | Open or focus the chat panel |
| `Odysseus: Open New Chat Panel` | Always open a fresh panel |
| `Odysseus: New Session` | Start a new session in the active panel |
| `Odysseus: Send Selection to Chat` | Append `@file:line` reference to chat input |
| `Odysseus: Insert @-mention for Current File/Selection` | `Alt+K` — insert file reference |
| `Odysseus: Configure` | Set server URL |

## Settings

| Setting | Default | Description |
|---|---|---|
| `odysseus.url` | `http://localhost:7860` | Odysseus server URL |
| `odysseus.useCtrlEnterToSend` | `false` | Use Ctrl+Enter to send; plain Enter adds newline |
| `odysseus.agentMode` | `true` | Enable agent mode by default |
| `odysseus.allowBash` | `true` | Allow bash tool by default |
| `odysseus.allowWebSearch` | `true` | Allow web search by default |

## Architecture

The extension is a frontend to a remote Odysseus server — it does not make LLM calls directly. The agent runs on the server and communicates via SSE streaming. File edits happen through bash commands executed on the server; the extension detects written paths from tool output and opens diffs after the fact.

This is different from extensions where the AI operates inside VS Code via the edit API. The tradeoff: you get a fully self-hosted stack with your own models, multi-user auth, TOTP 2FA, and any LLM endpoint Odysseus supports — at the cost of post-write rather than pre-write edit approval.
