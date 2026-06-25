import * as vscode from "vscode";
import { OdysseusViewProvider } from "./OdysseusViewProvider";
import { ChatPanel } from "./ChatPanel";
import { MemoryViewProvider } from "./MemoryViewProvider";
import { NotesViewProvider } from "./NotesViewProvider";
import { initRulesWatcher, createOdysseusRulesFile } from "./workspaceRules";
import { initIgnoreWatcher } from "./odysseusIgnore";
import { listRevertableRuns, revertRun } from "./checkpointManager";
import { runHeadlessTask, listTaskHistory } from "./taskRunner";
import { initScheduler, listSchedules, addSchedule, removeSchedule, toggleSchedule, getNextRunLabel, validateCron, nextCronDate } from "./scheduler";
import { generateCommitMessage } from "./gitPanel";

export function activate(context: vscode.ExtensionContext): void {
  initRulesWatcher(context);
  initIgnoreWatcher(context);

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

  context.subscriptions.push(
    vscode.commands.registerCommand("odysseus.createRulesFile", () => {
      createOdysseusRulesFile();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("odysseus.cancelRun", () => {
      ChatPanel.getCurrent()?.cancelRun();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("odysseus.searchCodebase", async () => {
      const q = await vscode.window.showInputBox({
        prompt: "Search codebase",
        placeHolder: "Regex or keyword…",
      });
      if (!q?.trim()) { return; }
      const panel = ChatPanel.getCurrent() ?? ChatPanel.createOrShow(context);
      await panel.searchCodebase(q.trim());
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("odysseus.revertSession", async () => {
      const runs = listRevertableRuns(context);
      if (!runs.length) {
        vscode.window.showInformationMessage("Odysseus: no revertable runs found.");
        return;
      }
      const items = runs.map(r => ({
        label: new Date(r.timestamp).toLocaleString(),
        description: `${r.fileCount} file(s) — session ${r.sessionId.slice(0, 8)}`,
        runId: r.runId,
        fileCount: r.fileCount,
      }));
      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: "Select a run to revert its file changes",
        title: "Revert Agent Run",
      });
      if (!pick) { return; }
      const confirm = await vscode.window.showQuickPick(["Yes, revert", "Cancel"], {
        placeHolder: `Restore ${pick.fileCount} file(s) to their pre-run state?`,
      });
      if (confirm !== "Yes, revert") { return; }
      const { restored, errors } = await revertRun(context, pick.runId);
      if (errors.length) {
        vscode.window.showWarningMessage(`Reverted ${restored} file(s). Errors: ${errors.join(", ")}`);
      } else {
        vscode.window.showInformationMessage(`Reverted ${restored} file(s) to pre-run state.`);
      }
    })
  );

  // Start scheduler polling engine
  initScheduler(context);

  // Internal: reveal the Odysseus Tasks output channel
  context.subscriptions.push(
    vscode.commands.registerCommand("odysseus.showTaskOutput", () => {
      vscode.commands.executeCommand("workbench.action.output.show", "Odysseus Tasks");
    })
  );

  // Internal: open a task session in the chat panel (called from taskRunner notification)
  context.subscriptions.push(
    vscode.commands.registerCommand("odysseus.openTaskSession", (sessionId: string) => {
      ChatPanel.createOrShow(context, sessionId);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("odysseus.runTask", async () => {
      const prompt = await vscode.window.showInputBox({
        prompt: "Describe the task for Odysseus to run",
        placeHolder: "e.g. Add error handling to all API calls in src/",
        ignoreFocusOut: true,
      });
      if (!prompt?.trim()) { return; }
      await runHeadlessTask(context, prompt.trim());
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("odysseus.showTaskHistory", async () => {
      const history = listTaskHistory(context);
      if (!history.length) {
        vscode.window.showInformationMessage("Odysseus: no task history yet.");
        return;
      }
      const items = history.map(r => ({
        label: r.prompt.slice(0, 60) + (r.prompt.length > 60 ? "…" : ""),
        description: `${r.status === "done" ? "✓" : "✗"} ${r.steps} steps  |  ${new Date(r.timestamp).toLocaleString()}`,
        sessionId: r.sessionId,
      }));
      const pick = await vscode.window.showQuickPick(items, {
        title: "Odysseus Task History",
        placeHolder: "Select a task to open its session in chat",
      });
      if (!pick) { return; }
      ChatPanel.createOrShow(context, pick.sessionId);
    })
  );

  const CRON_PRESETS = [
    { label: "Every 15 minutes",        cronExpr: "*/15 * * * *" },
    { label: "Every hour",              cronExpr: "0 * * * *" },
    { label: "Daily at 9 am",           cronExpr: "0 9 * * *" },
    { label: "Weekdays at 9 am",        cronExpr: "0 9 * * 1-5" },
    { label: "Weekly on Monday 9 am",   cronExpr: "0 9 * * 1" },
    { label: "Custom…",                 cronExpr: "" },
  ];

  context.subscriptions.push(
    vscode.commands.registerCommand("odysseus.scheduleTask", async () => {
      const name = await vscode.window.showInputBox({ prompt: "Schedule name", placeHolder: "e.g. Daily standup review" });
      if (!name?.trim()) { return; }

      const taskPrompt = await vscode.window.showInputBox({
        prompt: "Task prompt",
        placeHolder: "What should the agent do?",
        ignoreFocusOut: true,
      });
      if (!taskPrompt?.trim()) { return; }

      const presetPick = await vscode.window.showQuickPick(
        CRON_PRESETS.map(p => ({ label: p.label, description: p.cronExpr || "", cronExpr: p.cronExpr })),
        { title: "How often?", placeHolder: "Select schedule frequency" }
      );
      if (!presetPick) { return; }

      let cronExpr = presetPick.cronExpr;
      if (!cronExpr) {
        const custom = await vscode.window.showInputBox({
          prompt: "Cron expression (MIN HOUR DOM MON DOW)",
          placeHolder: "0 9 * * 1-5",
          validateInput: val => validateCron(val) ?? undefined,
        });
        if (!custom?.trim()) { return; }
        cronExpr = custom.trim();
      }

      const err = validateCron(cronExpr);
      if (err) { vscode.window.showErrorMessage(`Invalid cron: ${err}`); return; }

      const cfg = vscode.workspace.getConfiguration("odysseus");
      const schedule = {
        id: Date.now().toString(),
        name: name.trim(),
        prompt: taskPrompt.trim(),
        cronExpr,
        enabled: true,
        timeoutMinutes: cfg.get<number>("schedulerTimeoutMinutes", 30),
      };
      await addSchedule(context, schedule);

      const next = nextCronDate(cronExpr);
      vscode.window.showInformationMessage(
        `Schedule "${name}" created. Next run: ${next?.toLocaleString() ?? "never"}.`
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("odysseus.showSchedules", async () => {
      const refresh = async () => {
        const schedules = listSchedules(context);
        if (!schedules.length) {
          vscode.window.showInformationMessage("No schedules yet. Use 'Odysseus: Schedule New Task' to create one.");
          return;
        }
        const items = schedules.map(s => ({
          label: `${s.enabled ? "$(check)" : "$(circle-slash)"} ${s.name}`,
          description: `${s.cronExpr}`,
          detail: `next: ${getNextRunLabel(s)}${s.lastRun ? "  |  last: " + new Date(s.lastRun).toLocaleString() : ""}`,
          id: s.id,
          enabled: s.enabled,
        }));
        const pick = await vscode.window.showQuickPick(items, {
          title: "Odysseus Schedules",
          placeHolder: "Select a schedule to manage",
        });
        if (!pick) { return; }
        const actions = [
          { label: pick.enabled ? "$(debug-pause) Disable" : "$(play) Enable", action: "toggle" },
          { label: "$(run) Run now",  action: "run" },
          { label: "$(trash) Delete", action: "delete" },
        ];
        const action = await vscode.window.showQuickPick(actions, { title: `Manage: ${pick.label}` });
        if (!action) { return; }
        if (action.action === "toggle") {
          await toggleSchedule(context, pick.id);
          vscode.window.showInformationMessage(`Schedule "${pick.label.replace(/^\$\(\S+\) /, "")}" ${pick.enabled ? "disabled" : "enabled"}.`);
        } else if (action.action === "run") {
          const sched = listSchedules(context).find(s => s.id === pick.id);
          if (sched) { void runHeadlessTask(context, sched.prompt); }
        } else if (action.action === "delete") {
          const confirm = await vscode.window.showQuickPick(["Yes, delete", "Cancel"], { placeHolder: `Delete schedule "${pick.label.replace(/^\$\(\S+\) /, "")}"?` });
          if (confirm === "Yes, delete") {
            await removeSchedule(context, pick.id);
            vscode.window.showInformationMessage("Schedule deleted.");
          }
        }
        await refresh();
      };
      await refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("odysseus.showSessionDiff", () => {
      const panel = ChatPanel.getCurrent();
      if (!panel) { vscode.window.showInformationMessage("Odysseus: no active chat panel."); return; }
      panel.showSessionDiff();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("odysseus.generateCommitMessage", () => {
      generateCommitMessage(context);
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
