import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface BotModel {
  provider: string;
  id: string;
}

export interface StoredBotSettings {
  packages: string[];
  thinking?: ThinkingLevel;
}

function readJsonObject(path: string): Record<string, unknown> | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export function packageSourceString(entry: unknown): string | undefined {
  if (typeof entry === "string" && entry.trim()) return entry;
  if (entry && typeof entry === "object") {
    const source = (entry as { source?: unknown }).source;
    if (typeof source === "string" && source.trim()) return source;
  }
  return undefined;
}

/** Shared agent settings minus packages: a new bot starts from the user's choices. */
export function seedSharedSettings(sharedDir: string): Record<string, unknown> {
  const shared = readJsonObject(join(sharedDir, "settings.json")) ?? {};
  const { packages: _packages, ...rest } = shared;
  return rest;
}

export function readStoredSettings(dir: string): StoredBotSettings {
  const raw = readJsonObject(join(dir, "settings.json")) ?? {};
  const packages = Array.isArray(raw.packages)
    ? raw.packages.map(packageSourceString).filter((source): source is string => source !== undefined)
    : [];
  const thinkingRaw = raw.defaultThinkingLevel;
  const thinking =
    typeof thinkingRaw === "string" && (THINKING_LEVELS as readonly string[]).includes(thinkingRaw)
      ? (thinkingRaw as ThinkingLevel)
      : undefined;
  return { packages, ...(thinking ? { thinking } : {}) };
}

/** Package sources that are not npm:/git:/http(s) are local paths. */
export function isLocalPackageSource(source: string): boolean {
  return !/^(npm:|git:|github:|https?:|ssh:)/i.test(source.trim());
}

export function settingsManager(dir: string): SettingsManager {
  return SettingsManager.create(dir, dir);
}

export function packageManager(dir: string, settings: SettingsManager = settingsManager(dir)): DefaultPackageManager {
  return new DefaultPackageManager({ cwd: dir, agentDir: dir, settingsManager: settings });
}
