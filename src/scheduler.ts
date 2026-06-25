import * as vscode from "vscode";
import { runHeadlessTask } from "./taskRunner";

export interface Schedule {
  id: string;
  name: string;
  prompt: string;
  cronExpr: string;
  enabled: boolean;
  timeoutMinutes: number;
  lastRun?: string;   // ISO timestamp
  nextRun?: string;   // ISO timestamp, pre-computed
}

const SCHEDULES_KEY = "odysseus.schedules";

// ─── Cron parser ────────────────────────────────────────────────────────────

function parseCronField(field: string, min: number, max: number): Set<number> {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const p = part.trim();
    if (p === "*") {
      for (let i = min; i <= max; i++) { values.add(i); }
    } else if (p.startsWith("*/")) {
      const step = Math.max(1, parseInt(p.slice(2), 10));
      for (let i = min; i <= max; i++) {
        if (i % step === 0) { values.add(i); }
      }
    } else if (p.includes("-")) {
      const [lo, hi] = p.split("-").map(Number);
      for (let i = Math.max(lo, min); i <= Math.min(hi, max); i++) { values.add(i); }
    } else {
      const n = parseInt(p, 10);
      if (!isNaN(n) && n >= min && n <= max) { values.add(n); }
    }
  }
  return values;
}

export function nextCronDate(cronExpr: string, after: Date = new Date()): Date | null {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) { return null; }
  const [minF, hourF, domF, monF, dowF] = parts;
  const minutes = parseCronField(minF, 0, 59);
  const hours   = parseCronField(hourF, 0, 23);
  const doms    = parseCronField(domF, 1, 31);
  const months  = parseCronField(monF, 1, 12);
  const dows    = parseCronField(dowF, 0, 6);
  const domStar = domF === "*";
  const dowStar = dowF === "*";

  // Start 1 minute ahead
  const d = new Date(after.getTime());
  d.setSeconds(0, 0);
  d.setTime(d.getTime() + 60_000);

  const limit = new Date(after.getTime() + 366 * 24 * 60 * 60 * 1000);

  while (d <= limit) {
    if (!months.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    // Standard Vixie cron: if both dom and dow are non-*, use OR
    const domMatch = doms.has(d.getDate());
    const dowMatch = dows.has(d.getDay());
    const dayMatch = domStar && dowStar ? true
                   : domStar            ? dowMatch
                   : dowStar            ? domMatch
                   :                     domMatch || dowMatch;
    if (!dayMatch) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!hours.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!minutes.has(d.getMinutes())) {
      d.setTime(d.getTime() + 60_000);
      continue;
    }
    return d;
  }
  return null;
}

export function validateCron(expr: string): string | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) { return "Must have exactly 5 fields: MIN HOUR DOM MON DOW"; }
  const next = nextCronDate(expr);
  if (!next) { return "No future date found for this expression"; }
  return null;
}

// ─── Storage ─────────────────────────────────────────────────────────────────

export function listSchedules(context: vscode.ExtensionContext): Schedule[] {
  return context.workspaceState.get<Schedule[]>(SCHEDULES_KEY, []);
}

async function persistSchedules(context: vscode.ExtensionContext, schedules: Schedule[]): Promise<void> {
  await context.workspaceState.update(SCHEDULES_KEY, schedules);
}

export async function addSchedule(context: vscode.ExtensionContext, schedule: Schedule): Promise<void> {
  const schedules = listSchedules(context);
  const next = schedule.enabled ? nextCronDate(schedule.cronExpr) : null;
  schedule.nextRun = next?.toISOString();
  schedules.push(schedule);
  await persistSchedules(context, schedules);
}

export async function removeSchedule(context: vscode.ExtensionContext, id: string): Promise<void> {
  await persistSchedules(context, listSchedules(context).filter(s => s.id !== id));
}

export async function toggleSchedule(context: vscode.ExtensionContext, id: string): Promise<void> {
  const schedules = listSchedules(context);
  const s = schedules.find(x => x.id === id);
  if (!s) { return; }
  s.enabled = !s.enabled;
  if (s.enabled) {
    s.nextRun = nextCronDate(s.cronExpr)?.toISOString();
  } else {
    s.nextRun = undefined;
  }
  await persistSchedules(context, schedules);
}

export function getNextRunLabel(s: Schedule): string {
  if (!s.enabled) { return "disabled"; }
  if (!s.nextRun) { return "never"; }
  return new Date(s.nextRun).toLocaleString();
}

// ─── Polling engine ───────────────────────────────────────────────────────────

async function checkAndRun(context: vscode.ExtensionContext): Promise<void> {
  const schedules = listSchedules(context);
  const now = Date.now();
  let dirty = false;

  for (const s of schedules) {
    if (!s.enabled || !s.nextRun) { continue; }
    if (new Date(s.nextRun).getTime() > now) { continue; }

    // Due — run it, compute next occurrence
    s.lastRun = new Date().toISOString();
    const cfg = vscode.workspace.getConfiguration("odysseus");
    const timeoutMs = (s.timeoutMinutes ?? cfg.get<number>("schedulerTimeoutMinutes", 30)) * 60_000;
    void runHeadlessTask(context, s.prompt, { timeoutMs, silent: true });

    const next = nextCronDate(s.cronExpr);
    s.nextRun = next?.toISOString();
    dirty = true;

    // Toast notification for scheduled run
    vscode.window.showInformationMessage(
      `Odysseus: scheduled task "${s.name}" started.`,
      "Show Output"
    ).then(sel => {
      if (sel === "Show Output") {
        vscode.commands.executeCommand("odysseus.showTaskOutput");
      }
    });
  }

  if (dirty) { await persistSchedules(context, schedules); }
}

export function initScheduler(context: vscode.ExtensionContext): void {
  // Poll every 60 seconds; also check immediately on startup
  void checkAndRun(context);
  const interval = setInterval(() => { void checkAndRun(context); }, 60_000);
  context.subscriptions.push({ dispose: () => clearInterval(interval) });
}
