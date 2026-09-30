import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { adminSettingsFor, writeAdminSettings } from "./admin.ts";
import { installPostCommitHook } from "./hooks.ts";
import { existingBotDir } from "./paths.ts";
import { isLocalPackageSource, packageManager, readStoredSettings } from "./settings.ts";
import { renderBehavior, renderSoul } from "./templates.ts";

// The reconciler re-establishes the service-owned invariants of a bot dir
// after the server has been stopped. It is idempotent and runs on create, on
// the apply marker, and on POST /api/bots/:name/reload.
//
//   - SOUL.md and BEHAVIOR.md exist;
//   - the post-commit hook is installed;
//   - the admin settings file matches the deployment;
//   - every package declared in settings.json or the admin layer is installed.
//
// Everything the agent owns (settings.json values, skills, extensions, notes)
// is left alone.

function ensureFile(path: string, content: string): boolean {
  if (existsSync(path)) return false;
  writeFileSync(path, content);
  return true;
}

function localPath(dir: string, source: string): string {
  if (source === "~" || source.startsWith("~/")) return join(homedir(), source.slice(2));
  return resolve(dir, source);
}

async function installPackages(dir: string, adminPackageSources: readonly string[]): Promise<void> {
  const sources = [...new Set([...readStoredSettings(dir).packages, ...adminPackageSources])];
  if (sources.length === 0) return;
  const manager = packageManager(dir);
  for (const source of sources) {
    if (isLocalPackageSource(source)) {
      // Local sources are used in place; the package manager resolves them
      // relative to the agent dir, which is the bot dir.
      if (!existsSync(localPath(dir, source))) throw new Error(`package source does not exist: ${source}`);
      continue;
    }
    if (manager.getInstalledPath(source, "user") !== undefined) continue;
    await manager.install(source);
  }
}

export interface ReconciledActions {
  createdSoul: boolean;
  createdBehavior: boolean;
}

/** Re-establish the bot's service-owned invariants; safe to call any time. */
export async function ensureInvariants(name: string, env: NodeJS.ProcessEnv = process.env): Promise<ReconciledActions> {
  const dir = existingBotDir(name);
  const createdSoul = ensureFile(resolve(dir, "SOUL.md"), renderSoul(name));
  const createdBehavior = ensureFile(resolve(dir, "BEHAVIOR.md"), renderBehavior(name));
  installPostCommitHook(dir);
  const admin = adminSettingsFor(dir, env);
  writeAdminSettings(dir, env);
  await installPackages(dir, admin.packages ?? []);
  return { createdSoul, createdBehavior };
}
