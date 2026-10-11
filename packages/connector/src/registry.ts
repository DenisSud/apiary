import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isApplyPending, isArchivedDir, isSetupPending } from "@apiary/pi-manager";
import { readJsonFile, removeFile, writeJsonAtomic } from "./files.ts";
import { botsHome, isValidBotName, routePath } from "./paths.ts";

export interface Route {
  serverId: string;
  socketPath: string;
  pid?: number;
  startedAt?: string;
}

export interface BotInfo {
  name: string;
  dir: string;
  hasRoute: boolean;
  archived: boolean;
  /** True while the agent still has to finish its `init` commit. */
  setup: boolean;
  /** True while a post-commit apply marker waits for a reload. */
  apply: boolean;
}

// Bots are directories under botsHome() that contain settings.json.
export function listBots(options: { includeArchived?: boolean } = {}): BotInfo[] {
  let names: string[];
  try {
    names = readdirSync(botsHome());
  } catch {
    return [];
  }
  const bots: BotInfo[] = [];
  for (const name of names) {
    if (!isValidBotName(name)) continue;
    const dir = join(botsHome(), name);
    if (!isDirectory(dir)) continue;
    if (!existsSync(join(dir, "settings.json"))) continue;
    const archived = isArchivedDir(dir);
    if (archived && !options.includeArchived) continue;
    bots.push({
      name,
      dir,
      hasRoute: existsSync(routePath(name)),
      archived,
      setup: isSetupPending(dir),
      apply: isApplyPending(dir),
    });
  }
  return bots.sort((a, b) => a.name.localeCompare(b.name));
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function readRoute(name: string): Route | undefined {
  const raw = readJsonFile<Partial<Route>>(routePath(name));
  if (!raw || typeof raw.serverId !== "string" || typeof raw.socketPath !== "string") {
    return undefined;
  }
  const route: Route = { serverId: raw.serverId, socketPath: raw.socketPath };
  if (typeof raw.pid === "number") route.pid = raw.pid;
  if (typeof raw.startedAt === "string") route.startedAt = raw.startedAt;
  return route;
}

export function writeRoute(name: string, route: Route): void {
  writeJsonAtomic(routePath(name), route);
}

export function clearRoute(name: string): void {
  removeFile(routePath(name));
}
