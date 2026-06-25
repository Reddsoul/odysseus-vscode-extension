import { exec } from "child_process";
import * as vscode from "vscode";
import { OdysseusClient } from "./api/client";
import { streamChat } from "./api/streaming";
import { getWorkspaceRoot } from "./context/fileContext";

function execCmd(cmd: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(cmd, { cwd, timeout: 10_000 }, (err, stdout, stderr) => {
      if (err) { reject(new Error(stderr.trim() || err.message)); } else { resolve(stdout); }
    });
  });
}

async function callOdysseus(context: vscode.ExtensionContext, prompt: string): Promise<string> {
  const cfg = vscode.workspace.getConfiguration("odysseus");
  const url = cfg.get<string>("url", "http://localhost:7860");
  const token = await context.secrets.get("odysseus.token");
  const client = new OdysseusClient(url, token);

  const endpoint = await client.resolveDefaultEndpoint();
  const session = await client.createSession("Git commit message", endpoint.model, endpoint.url);

  let result = "";
  await streamChat({
    baseUrl: url,
    token,
    sessionId: session.id,
    message: prompt,
    activeDocId: undefined,
    agentMode: false,
    allowBash: false,
    allowWebSearch: false,
    tzOffset: Math.round(new Date().getTimezoneOffset() * -1),
    onEvent: (ev) => {
      if (ev.type === "delta") { result += ev.text; }
    },
  });

  client.deleteSession(session.id).catch(() => {});
  return result.trim();
}

export async function generateCommitMessage(context: vscode.ExtensionContext): Promise<void> {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) {
    vscode.window.showWarningMessage("Odysseus: no workspace folder open.");
    return;
  }

  // Prefer staged diff; fall back to all uncommitted changes
  let diff = "";
  let diffLabel = "staged";
  try {
    diff = await execCmd("git diff --staged", workspaceRoot);
    if (!diff.trim()) {
      diff = await execCmd("git diff HEAD", workspaceRoot);
      diffLabel = "HEAD";
    }
  } catch {
    vscode.window.showErrorMessage("Odysseus: git diff failed — is this a git repository with git installed?");
    return;
  }

  if (!diff.trim()) {
    vscode.window.showInformationMessage("Odysseus: no uncommitted changes found.");
    return;
  }

  const MAX_DIFF = 8_000;
  const truncated = diff.length > MAX_DIFF;
  const diffText = diff.slice(0, MAX_DIFF) + (truncated ? "\n\n...(diff truncated)" : "");

  const prompt =
    `Generate a conventional commit message for the following git diff (${diffLabel} changes).\n` +
    `Output ONLY the commit message — subject line + optional blank line + body. No explanation.\n` +
    `Use conventional commit format: type(scope): short description\n\n` +
    "```diff\n" + diffText + "\n```";

  let commitMsg = "";
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Odysseus: generating commit message…", cancellable: false },
    async () => { commitMsg = await callOdysseus(context, prompt); }
  );

  if (!commitMsg) {
    vscode.window.showErrorMessage("Odysseus: failed to generate commit message.");
    return;
  }

  // Show in a document so user can edit before committing
  const doc = await vscode.workspace.openTextDocument({ content: commitMsg, language: "git-commit" });
  await vscode.window.showTextDocument(doc, { preview: false });

  // Also try to set the SCM input box
  const gitExt = vscode.extensions.getExtension("vscode.git");
  if (gitExt?.isActive) {
    try {
      const gitApi = gitExt.exports.getAPI(1);
      const repo = gitApi?.repositories?.[0];
      if (repo) {
        repo.inputBox.value = commitMsg.split("\n")[0]; // subject line only in input box
      }
    } catch { /* git extension API may not be available */ }
  }
}
