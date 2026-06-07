import * as vscode from "vscode";
import { OdysseusViewProvider } from "./OdysseusViewProvider";
import { ChatPanel } from "./ChatPanel";
import { MemoryViewProvider } from "./MemoryViewProvider";
import { NotesViewProvider } from "./NotesViewProvider";

export function activate(context: vscode.ExtensionContext): void {
  const provider = new OdysseusViewProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      OdysseusViewProvider.viewId,
      provider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  const memoryProvider = new MemoryViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("odysseus.memoryView", memoryProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  const notesProvider = new NotesViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("odysseus.notesView", notesProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("odysseus.openChat", () => {
      ChatPanel.createOrShow(context);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("odysseus.configure", () => {
      provider.configure();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("odysseus.newSession", () => {
      ChatPanel.getCurrent()?.newSession() ?? provider.newSession();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("odysseus.sendSelection", () => {
      const panel = ChatPanel.getCurrent();
      if (panel) {
        panel.sendSelection();
      } else {
        ChatPanel.createOrShow(context).sendSelection();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("odysseus.insertAtMention", () => {
      const panel = ChatPanel.getCurrent();
      if (!panel) { return; }
      panel.insertAtMention();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("odysseus.openNewChat", () => {
      ChatPanel.createNewPanel(context);
    })
  );

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = "odysseus.openChat";
  statusBar.text = "$(comment) Odysseus";
  statusBar.tooltip = "Open Odysseus chat";
  statusBar.show();
  context.subscriptions.push(statusBar);
  ChatPanel.setStatusBar(statusBar);

  context.subscriptions.push(
    vscode.commands.registerCommand("odysseus.searchMessages", async () => {
      const panel = ChatPanel.getCurrent() ?? ChatPanel.createOrShow(context);
      const q = await vscode.window.showInputBox({ prompt: "Search messages", placeHolder: "Type to search across all sessions…" });
      if (!q?.trim()) { return; }
      panel.searchMessages(q.trim());
    })
  );

  // Register content provider for pre-edit snapshots (diff viewer)
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider("odysseus-original", {
      provideTextDocumentContent(uri) {
        return ChatPanel.getPreEditSnapshotFromAny(uri.path) ?? "";
      },
    })
  );

  // URI handler: vscode://JoseAlma.odysseus-vscode-extension/open?prompt=...
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
}

export function deactivate(): void {}
