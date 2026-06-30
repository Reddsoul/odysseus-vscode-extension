import * as vscode from "vscode";
import { OdysseusClient } from "./api/client";
import { streamChat } from "./api/streaming";
import { buildApiMessage, getWorkspaceRoot } from "./context/fileContext";
import { getWorkspaceRulesContent } from "./workspaceRules";
import { getGitContext } from "./gitIntegration";

export interface TaskRecord {
  runId: number;
  timestamp: string;
  prompt: string;
  sessionId: string;
  steps: number;
  status: "done" | "error";
}

const HISTORY_KEY = "odysseus.taskHistory";
const MAX_HISTORY = 50;
const SEP = "═".repeat(55);

let _channel: vscode.OutputChannel | undefined;

function getChannel(): vscode.OutputChannel {
  if (!_channel) { _channel = vscode.window.createOutputChannel("Odysseus Tasks"); }
  return _channel;
}

export function listTaskHistory(context: vscode.ExtensionContext): TaskRecord[] {
  return context.workspaceState.get<TaskRecord[]>(HISTORY_KEY, []);
}

async function saveTaskRecord(context: vscode.ExtensionContext, record: TaskRecord): Promise<void> {
  const history = context.workspaceState.get<TaskRecord[]>(HISTORY_KEY, []);
  history.unshift(record);
  history.splice(MAX_HISTORY);
  await context.workspaceState.update(HISTORY_KEY, history);
}

export async function runHeadlessTask(
  context: vscode.ExtensionContext,
  prompt: string,
  options?: { timeoutMs?: number; silent?: boolean }
): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("odysseus");
  const url = cfg.get<string>("url", "http://localhost:7860");
  const token = await context.secrets.get("odysseus.token");
  const client = new OdysseusClient(url, token);

  // Build context-enriched message
  const workspaceRoot = getWorkspaceRoot();
  const workspaceRules = await getWorkspaceRulesContent();
  const gitContext = (workspaceRoot && cfg.get<boolean>("injectGitContext", true))
    ? await getGitContext(workspaceRoot) : null;
  const apiMessage = await buildApiMessage(
    prompt, workspaceRoot, null, false,
    workspaceRules, gitContext,
    cfg.get<boolean>("injectWorkspaceTree", true)
  );

  // Create a dedicated session for this task
  let sessionId: string;
  try {
    const endpoint = await client.resolveDefaultEndpoint();
    const session = await client.createSession(
      `Task: ${prompt.slice(0, 40)}`,
      endpoint.model,
      endpoint.url
    );
    sessionId = session.id;
  } catch (err) {
    vscode.window.showErrorMessage(`Odysseus: session creation failed — ${String(err)}`);
    return;
  }

  const ch = getChannel();
  if (!options?.silent) { ch.show(true); }
  ch.appendLine(`\n${SEP}`);
  ch.appendLine(`▶  ${prompt}`);
  ch.appendLine(`   Session: ${sessionId}  |  ${new Date().toLocaleString()}`);
  ch.appendLine(SEP);

  const statusDisposable = vscode.window.setStatusBarMessage("$(sync~spin) Odysseus: running task…");
  const runId = Date.now();
  let steps = 0;
  let hasError = false;

  // Timeout: stop the run if it exceeds the limit
  let timeoutHandle: NodeJS.Timeout | undefined;
  if (options?.timeoutMs) {
    const limitMin = Math.round(options.timeoutMs / 60_000);
    timeoutHandle = setTimeout(async () => {
      ch.appendLine(`\n  TIMEOUT: exceeded ${limitMin}m limit — stopping`);
      try { await client.stopChat(sessionId); } catch { /* ignore */ }
    }, options.timeoutMs);
  }

  try {
    await streamChat({
      baseUrl: url,
      token,
      sessionId,
      message: apiMessage,
      activeDocId: undefined,
      agentMode: true,
      allowBash: cfg.get<boolean>("allowBash", true),
      allowWebSearch: cfg.get<boolean>("allowWebSearch", true),
      tzOffset: Math.round(new Date().getTimezoneOffset() * -1),
      onEvent: (ev) => {
        switch (ev.type) {
          case "delta":
            ch.append(ev.text);
            break;
          case "tool_start":
            ch.appendLine(`\n  ↳ [${ev.tool}] ${(ev.command ?? ev.tool_input ?? "").slice(0, 200)}`);
            break;
          case "tool_output":
            if (ev.exit_code !== undefined && ev.exit_code !== 0) {
              ch.appendLine(`  ✗ exit_code=${ev.exit_code}: ${ev.output.slice(0, 200)}`);
            }
            break;
          case "agent_step":
            steps = ev.round;
            ch.appendLine(`\n  ── step ${steps} ──`);
            break;
          case "error":
            ch.appendLine(`\n  ERROR: ${ev.message}`);
            hasError = true;
            break;
        }
      },
    });
  } catch (err) {
    ch.appendLine(`\n  FAILED: ${String(err)}`);
    hasError = true;
  } finally {
    if (timeoutHandle) { clearTimeout(timeoutHandle); }
    statusDisposable.dispose();
  }

  ch.appendLine(`\n${SEP}`);
  ch.appendLine(`${hasError ? "✗ Failed" : "✓ Done"} — ${steps} step(s)  |  ${new Date().toLocaleString()}`);
  ch.appendLine(SEP);

  await saveTaskRecord(context, { runId, timestamp: new Date().toISOString(), prompt, sessionId, steps, status: hasError ? "error" : "done" });

  if (!hasError && !options?.silent) {
    const action = await vscode.window.showInformationMessage(
      `Odysseus task complete — ${steps} step(s).`,
      "Open in Chat"
    );
    if (action === "Open in Chat") {
      await vscode.commands.executeCommand("odysseus.openTaskSession", sessionId);
    }
  }
}
