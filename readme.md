# Odysseus AI Helper

VS Code extension for a self-hosted Odysseus AI assistant. Connects to your local Odysseus server and gives you an agent-capable chat panel directly inside VS Code.

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

### Message History
- **Edit & delete past messages** — hover any message in the conversation history to reveal edit and delete buttons. Edit a message to re-send it to the agent; delete to remove it.
- Message history replay when switching sessions (falls back to a divider if backend has no history endpoint)

### Edit Review
- Pre-send autosave — dirty buffers are saved before the agent runs so it reads fresh disk content
- Post-write diff viewer — when the agent modifies a file, a VS Code diff opens automatically showing original vs modified
- Revert button — inline "Revert" action in the chat restores the pre-edit snapshot without touching the conversation

### Session Management
- Session history sidebar with search, grouped by Today / Yesterday / Last 7 days / Older
- **Session operations** — hover a session in the sidebar to compact, fork, truncate, star (mark as important), rename, or delete. Compacting summarizes old messages; forking creates an independent copy.
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