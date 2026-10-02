import { writeFileSync } from "node:fs";
import { adminSettingsPath, baseSourceFor } from "./paths.ts";
import type { BotModel } from "./settings.ts";

// The admin layer: the small service-owned configuration a bot cannot change.
// `writeAdminSettings` materializes it per bot; the server reads the file via
// PI_ADMIN_SETTINGS and merges it after global + project settings (model wins,
// packages union, defaultTools union floor). The reconciler rewrites it on
// every start/reload, so it always reflects the deployment.

export const DEFAULT_BOT_MODEL: BotModel = { provider: "opencode-go", id: "deepseek-v4.1-flash" };
export const DEFAULT_TOOL_FLOOR = ["read", "write", "edit", "bash"] as const;

export interface AdminSettings {
  defaultProvider?: string;
  defaultModel?: string;
  /** Mandatory package sources (the base package plus deployment extras). */
  packages?: string[];
  /** Tools every bot keeps active regardless of its own selection. */
  defaultTools?: string[];
}

/** The enforced model: PI_BOT_MODEL="provider/model", else the default. */
export function serviceModel(env: NodeJS.ProcessEnv = process.env): BotModel {
  const raw = env.PI_BOT_MODEL?.trim();
  if (raw) {
    const slash = raw.indexOf("/");
    if (slash > 0 && slash < raw.length - 1) return { provider: raw.slice(0, slash), id: raw.slice(slash + 1) };
  }
  return DEFAULT_BOT_MODEL;
}

/** Extra mandatory package sources: PI_BOT_PACKAGES="a,b" (deployment-level). */
function extraPackages(env: NodeJS.ProcessEnv): string[] {
  return (env.PI_BOT_PACKAGES ?? "")
    .split(",")
    .map((source) => source.trim())
    .filter(Boolean);
}

export function adminSettingsFor(dir: string, env: NodeJS.ProcessEnv = process.env): AdminSettings {
  const model = serviceModel(env);
  return {
    defaultProvider: model.provider,
    defaultModel: model.id,
    packages: [baseSourceFor(dir), ...extraPackages(env)],
    defaultTools: [...DEFAULT_TOOL_FLOOR],
  };
}

/** Write the bot's admin settings file; returns its path. */
export function writeAdminSettings(dir: string, env: NodeJS.ProcessEnv = process.env): string {
  const path = adminSettingsPath(dir);
  writeFileSync(path, `${JSON.stringify(adminSettingsFor(dir, env), null, 2)}\n`);
  return path;
}
