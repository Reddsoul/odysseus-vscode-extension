import * as vscode from "vscode";
import { OdysseusClient } from "../api/client";
import { FileContext, fileTitle } from "../context/fileContext";

export class DocSync {
  private fileToDocId = new Map<string, string>();
  private client: OdysseusClient;

  constructor(client: OdysseusClient) {
    this.client = client;
  }

  reset(): void {
    this.fileToDocId.clear();
  }

  async syncFile(ctx: FileContext, sessionId: string): Promise<string> {
    const existing = this.fileToDocId.get(ctx.filePath);
    if (existing) {
      await this.client.updateDocument(existing, ctx.content);
      return existing;
    }

    const doc = await this.client.createDocument(
      fileTitle(ctx.filePath),
      ctx.language,
      ctx.content,
      sessionId
    );
    this.fileToDocId.set(ctx.filePath, doc.id);
    return doc.id;
  }

  async applyRemoteEdits(
    filePath: string,
    localContent: string
  ): Promise<void> {
    const docId = this.fileToDocId.get(filePath);
    if (!docId) {
      return;
    }

    let remote: { content: string };
    try {
      remote = (await this.client.getDocument(docId)) as { content: string };
    } catch {
      return;
    }

    if (remote.content === localContent) {
      return;
    }

    const uri = vscode.Uri.file(filePath);
    const editor = vscode.window.visibleTextEditors.find(
      (e) => e.document.uri.fsPath === filePath
    );

    if (!editor) {
      return;
    }

    const edit = new vscode.WorkspaceEdit();
    const doc = editor.document;
    const fullRange = new vscode.Range(
      doc.positionAt(0),
      doc.positionAt(doc.getText().length)
    );
    edit.replace(uri, fullRange, remote.content);
    await vscode.workspace.applyEdit(edit);

    const linesBefore = localContent.split("\n").length;
    const linesAfter = remote.content.split("\n").length;
    const diff = Math.abs(linesAfter - linesBefore);
    if (diff > 0) {
      vscode.window.setStatusBarMessage(
        `Odysseus edited ${diff} line${diff !== 1 ? "s" : ""}`,
        4000
      );
    }
  }
}
