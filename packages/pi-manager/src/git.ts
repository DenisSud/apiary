import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

// Agent repos are machine-managed; a fixed identity keeps commits honest and
// keeps tests independent of the user's global git config.
const IDENTITY = ["-c", "user.name=pi-bots", "-c", "user.email=pi-bots@localhost"];

export function git(dir: string, args: string[]): { code: number; stdout: string; stderr: string } {
  const result = spawnSync("git", ["-C", dir, ...IDENTITY, ...args], { encoding: "utf8" });
  if (result.error) throw result.error;
  return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

export function initRepo(dir: string): void {
  const result = git(dir, ["init", "-q", "-b", "main"]);
  if (result.code !== 0) throw new Error(`git init failed: ${result.stderr.trim()}`);
}

export function isRepo(dir: string): boolean {
  return existsSync(join(dir, ".git"));
}

/** Stage and commit only the given paths; returns false when nothing changed. */
export function commitPaths(dir: string, paths: string[], message: string): boolean {
  if (!isRepo(dir)) return false;
  const existing = paths.filter((path) => existsSync(join(dir, path)));
  if (existing.length === 0) return false;
  const add = git(dir, ["add", "--", ...existing]);
  if (add.code !== 0) throw new Error(`git add failed: ${add.stderr.trim()}`);
  const staged = git(dir, ["diff", "--cached", "--quiet", "--", ...existing]);
  if (staged.code === 0) return false;
  const commit = git(dir, ["commit", "-q", "-m", message, "--", ...existing]);
  if (commit.code !== 0) throw new Error(`git commit failed: ${commit.stderr.trim()}`);
  return true;
}
