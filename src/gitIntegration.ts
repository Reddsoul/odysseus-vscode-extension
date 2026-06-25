import { exec } from "child_process";

export function getGitContext(workspaceRoot: string): Promise<string | null> {
  return new Promise((resolve) => {
    const results: { status?: string; diff?: string } = {};
    let pending = 2;
    const done = () => {
      if (--pending > 0) { return; }
      const status = (results.status ?? "").trim();
      const diff = (results.diff ?? "").trim();
      if (!status && !diff) { resolve(null); return; }
      const lines: string[] = [];
      if (status) { lines.push(`=== git status ===\n${status}`); }
      if (diff)   { lines.push(`=== git diff --stat HEAD ===\n${diff}`); }
      resolve(lines.join("\n\n"));
    };

    exec("git status --short", { cwd: workspaceRoot, timeout: 5000 }, (err, stdout) => {
      results.status = err ? "" : stdout;
      done();
    });
    exec("git diff --stat HEAD", { cwd: workspaceRoot, timeout: 5000 }, (err, stdout) => {
      results.diff = err ? "" : stdout;
      done();
    });
  });
}
