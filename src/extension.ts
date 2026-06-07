import * as vscode from "vscode";
import { OdysseusViewProvider } from "./OdysseusViewProvider";
import { ChatPanel } from "./ChatPanel";

export function activate(context: vscode.ExtensionContext): void {
  const provider = new OdysseusViewProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      OdysseusViewProvider.viewId,
      provider,
      { webviewOptions: { retainContextWhenHidden: false } }
    )
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
}

export function deactivate(): void {}
