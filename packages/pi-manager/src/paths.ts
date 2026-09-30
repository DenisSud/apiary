import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BotError } from "./errors.ts";

// Environment is read per call so tests and callers can point the roots at a
// temp dir after import.

export function botsHome(): string {
  return process.env.PI_BOTS_HOME ?? join(homedir(), "Bots");
}

export function sharedAgentDir(): string {
  return process.env.PI_SHARED_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

// The pi-bots checkout that owns the base pi package (extensions, skills).
export function basePackageDir(): string {
  return resolve(fileURLToPath(new URL("../../../base", import.meta.url)));
}

/** The package registry an agent may install from; the service exports it as PI_REGISTRY_DIR. */
export function registryDir(): string {
  return resolve(fileURLToPath(new URL("../../../registry", import.meta.url)));
}

/** The base package source as written into a bot's settings, relative to it. */
export function baseSourceFor(dir: string): string {
  return relative(dir, basePackageDir()).replaceAll("\\", "/");
}

// Existing bot dirs may predate the strict create rule.
const BOT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CREATE_NAME = /^[a-z0-9][a-z0-9-]*$/;

export function isValidBotName(name: string): boolean {
  return BOT_NAME.test(name);
}

export function isValidNewBotName(name: string): boolean {
  return CREATE_NAME.test(name);
}

export function assertBotName(name: string): string {
  if (!isValidBotName(name)) throw new Error(`invalid bot name: ${JSON.stringify(name)}`);
  return name;
}

export function botDir(name: string): string {
  return join(botsHome(), assertBotName(name));
}

/** The dir of an existing bot, or a not_found BotError. */
export function existingBotDir(name: string): string {
  if (!isValidBotName(name)) throw new BotError("not_found", `bot '${name}' not found`);
  const dir = join(botsHome(), name);
  if (!existsSync(join(dir, "settings.json"))) throw new BotError("not_found", `bot '${name}' not found`);
  return dir;
}

export function archivedMarker(dir: string): string {
  return join(dir, ".archived");
}

export function isArchivedDir(dir: string): boolean {
  return existsSync(archivedMarker(dir));
}

// Service state kept inside a bot dir, gitignored: setup-in-progress, the
// pending-apply marker the post-commit hook writes, and the admin settings
// file the server reads via PI_ADMIN_SETTINGS.
export function setupMarker(dir: string): string {
  return join(dir, ".setup");
}

export function isSetupPending(dir: string): boolean {
  return existsSync(setupMarker(dir));
}

export function applyMarker(dir: string): string {
  return join(dir, ".apply");
}

export function isApplyPending(dir: string): boolean {
  return existsSync(applyMarker(dir));
}

export function clearApplyMarker(dir: string): void {
  rmSync(applyMarker(dir), { force: true });
}

export function adminSettingsPath(dir: string): string {
  return join(dir, ".admin-settings.json");
}
