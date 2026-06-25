import * as vscode from "vscode";

interface RunDescriptor {
  sessionId: string;
  runId: number;
  timestamp: string;
  fileCount: number;
}

interface FileCheckpoint {
  filePath: string;
  content: string;
}

const MAX_RUNS = 10;
const MAX_FILES = 20;

export async function saveCheckpoints(
  context: vscode.ExtensionContext,
  sessionId: string,
  runId: number,
  snapshots: Map<string, string>
): Promise<void> {
  if (!snapshots.size) { return; }
  const files: FileCheckpoint[] = [];
  for (const [filePath, content] of snapshots) {
    if (files.length >= MAX_FILES) { break; }
    files.push({ filePath, content });
  }
  await context.workspaceState.update(`odysseus.ckpt.${runId}`, files);
  const runs = context.workspaceState.get<RunDescriptor[]>("odysseus.checkpoints", []);
  runs.unshift({ sessionId, runId, timestamp: new Date().toISOString(), fileCount: files.length });
  const evicted = runs.splice(MAX_RUNS);
  for (const old of evicted) {
    await context.workspaceState.update(`odysseus.ckpt.${old.runId}`, undefined);
  }
  await context.workspaceState.update("odysseus.checkpoints", runs);
}

export function listRevertableRuns(context: vscode.ExtensionContext): RunDescriptor[] {
  return context.workspaceState.get<RunDescriptor[]>("odysseus.checkpoints", []);
}

export async function revertRun(
  context: vscode.ExtensionContext,
  runId: number
): Promise<{ restored: number; errors: string[] }> {
  const files = context.workspaceState.get<FileCheckpoint[]>(`odysseus.ckpt.${runId}`, []);
  let restored = 0;
  const errors: string[] = [];
  for (const { filePath, content } of files) {
    try {
      await vscode.workspace.fs.writeFile(vscode.Uri.file(filePath), Buffer.from(content, "utf-8"));
      restored++;
    } catch (err) {
      errors.push(`${filePath}: ${String(err)}`);
    }
  }
  return { restored, errors };
}
