import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_TOOL_FLOOR, serviceModel } from "./admin.ts";
import { BotError } from "./errors.ts";
import { commitPaths, initRepo } from "./git.ts";
import { installPostCommitHook } from "./hooks.ts";
import {
  archivedMarker,
  baseSourceFor,
  botDir,
  botsHome,
  existingBotDir,
  isArchivedDir,
  isSetupPending,
  isValidBotName,
  isValidNewBotName,
  setupMarker,
  sharedAgentDir,
} from "./paths.ts";
import { ensureInvariants } from "./reconcile.ts";
import {
  THINKING_LEVELS,
  type BotModel,
  type ThinkingLevel,
  packageManager,
  packageSourceString,
  readStoredSettings,
  seedSharedSettings,
  settingsManager,
} from "./settings.ts";
import { renderBehavior, renderSoul } from "./templates.ts";

export interface CreateBotInput {
  name: string;
  packages?: string[];
  thinking?: ThinkingLevel;
}

export interface UpdateBotInput {
  packages?: string[];
  thinking?: ThinkingLevel;
}

export interface BotSummary {
  name: string;
  dir: string;
  archived: boolean;
  /** True while the agent still has to finish its `init` commit. */
  setup: boolean;
}

export interface BotDetail extends BotSummary {
  packages: string[];
  /** The service-enforced model; a bot cannot change it. */
  model: BotModel;
  thinking?: ThinkingLevel;
}

const SUBDIRS = ["skills", "extensions", "notes", "sessions"];
const SHARED_FILES = ["auth.json", "models.json", "models-store.json", "trust.json"];
const SCAFFOLD_PATHS = [".gitignore", "SOUL.md", "BEHAVIOR.md", "settings.json", ...SHARED_FILES];
const GITIGNORE = [
  "node_modules/",
  "sessions/",
  "git/",
  "pi-debug.log",
  "*.log",
  ".pi/",
  ".archived",
  ".setup",
  ".apply",
  ".admin-settings.json",
  "",
].join("\n");

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function linkSharedFiles(dir: string, shared: string): void {
  // A fresh container volume has no shared agent dir yet; create it so the
  // symlinks resolve and the auth flow can write through them.
  mkdirSync(shared, { recursive: true });
  for (const file of SHARED_FILES) symlinkSync(join(shared, file), join(dir, file));
}

export async function createBot(input: CreateBotInput): Promise<BotDetail> {
  const { name } = input;
  if (!isValidNewBotName(name)) {
    throw new BotError("invalid", `invalid bot name '${name}': use lowercase letters, digits and dashes`);
  }
  if (input.thinking !== undefined && !THINKING_LEVELS.includes(input.thinking)) {
    throw new BotError("invalid", `invalid thinking level '${input.thinking}'`);
  }
  const dir = botDir(name);
  if (existsSync(dir)) throw new BotError("exists", `bot '${name}' already exists`);

  const settings: Record<string, unknown> = {
    ...seedSharedSettings(sharedAgentDir()),
    defaultTools: [...DEFAULT_TOOL_FLOOR],
    packages: [baseSourceFor(dir)],
  };
  if (input.thinking) settings.defaultThinkingLevel = input.thinking;

  mkdirSync(dir, { recursive: true });
  for (const sub of SUBDIRS) mkdirSync(join(dir, sub), { recursive: true });
  writeFileSync(join(dir, "SOUL.md"), renderSoul(name));
  writeFileSync(join(dir, "BEHAVIOR.md"), renderBehavior(name));
  writeFileSync(join(dir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
  writeFileSync(join(dir, ".gitignore"), GITIGNORE);
  linkSharedFiles(dir, sharedAgentDir());

  if (input.packages && input.packages.length > 0) {
    const settingsManagerInstance = settingsManager(dir);
    const manager = packageManager(dir, settingsManagerInstance);
    for (const source of input.packages) await manager.installAndPersist(source);
    await settingsManagerInstance.flush();
  }

  initRepo(dir);
  installPostCommitHook(dir);
  // The hook only lets an `init` commit apply while this marker exists.
  writeFileSync(setupMarker(dir), `${new Date().toISOString()}\n`);
  commitPaths(dir, SCAFFOLD_PATHS, `Scaffold ${name}`);
  await ensureInvariants(name);
  return readBot(name);
}

export function listBots(options: { includeArchived?: boolean } = {}): BotSummary[] {
  let names: string[];
  try {
    names = readdirSync(botsHome());
  } catch {
    return [];
  }
  const bots: BotSummary[] = [];
  for (const name of names) {
    if (!isValidBotName(name)) continue;
    const dir = join(botsHome(), name);
    if (!isDirectory(dir) || !existsSync(join(dir, "settings.json"))) continue;
    const archived = isArchivedDir(dir);
    if (archived && !options.includeArchived) continue;
    bots.push({ name, dir, archived, setup: isSetupPending(dir) });
  }
  return bots.sort((a, b) => a.name.localeCompare(b.name));
}

export function readBot(name: string): BotDetail {
  const dir = existingBotDir(name);
  const stored = readStoredSettings(dir);
  return {
    name,
    dir,
    archived: isArchivedDir(dir),
    setup: isSetupPending(dir),
    packages: stored.packages.filter((source) => source !== baseSourceFor(dir)),
    model: serviceModel(),
    ...(stored.thinking ? { thinking: stored.thinking } : {}),
  };
}

/** Replace the user package list, keeping the base package first. */
async function replacePackages(dir: string, next: readonly string[]): Promise<boolean> {
  const settings = settingsManager(dir);
  const manager = packageManager(dir, settings);
  const base = baseSourceFor(dir);
  const current = (settings.getGlobalSettings().packages ?? [])
    .map(packageSourceString)
    .filter((source): source is string => source !== undefined && source !== base);
  const added = next.filter((source) => !current.includes(source));
  const removed = current.filter((source) => !next.includes(source));
  if (added.length === 0 && removed.length === 0) return false;
  for (const source of removed) await manager.removeAndPersist(source);
  for (const source of added) await manager.installAndPersist(source);
  await settings.flush();
  return true;
}

export async function updateBot(name: string, changes: UpdateBotInput): Promise<BotDetail> {
  const dir = existingBotDir(name);
  if (changes.thinking !== undefined && !THINKING_LEVELS.includes(changes.thinking)) {
    throw new BotError("invalid", `invalid thinking level '${changes.thinking}'`);
  }
  const changed: string[] = [];

  if (changes.packages !== undefined && (await replacePackages(dir, changes.packages))) {
    changed.push("packages");
  }
  if (changes.thinking !== undefined) {
    const settings = settingsManager(dir);
    settings.setDefaultThinkingLevel(changes.thinking);
    await settings.flush();
    changed.push("thinking");
  }

  if (changed.length > 0) {
    commitPaths(dir, ["settings.json"], `config: ${changed.join(", ")}`);
  }
  return readBot(name);
}

export function archiveBot(name: string): BotDetail {
  const dir = existingBotDir(name);
  if (!isArchivedDir(dir)) {
    writeFileSync(archivedMarker(dir), `${JSON.stringify({ archivedAt: new Date().toISOString() }, null, 2)}\n`);
  }
  return readBot(name);
}

export function unarchiveBot(name: string): BotDetail {
  const dir = existingBotDir(name);
  rmSync(archivedMarker(dir), { force: true });
  return readBot(name);
}

export function deleteBot(name: string, options: { confirm: string }): void {
  if (options.confirm !== name) throw new BotError("invalid", `delete '${name}': confirm with { confirm: "${name}" }`);
  rmSync(existingBotDir(name), { recursive: true, force: true });
}
