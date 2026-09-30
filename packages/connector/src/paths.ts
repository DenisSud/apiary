import { homedir } from "node:os";
import { join } from "node:path";
import { assertBotName } from "@pi-bots/pi-manager";

// The agents root, bot name rules and shared agent dir belong to pi-manager;
// the connector re-exports them so callers keep one import site.
export { assertBotName, botsHome, isValidBotName } from "@pi-bots/pi-manager";

// Environment is read per call so tests and callers can point the state root
// at a temp dir after import.

export function stateRoot(): string {
  return process.env.PI_CONNECTOR_DIR ?? join(homedir(), ".pi", "bots");
}

export function serversDir(): string {
  return join(stateRoot(), "servers");
}

// One logical server per bot: a shared PI_SERVER_DIR would collide on
// default-server-id, and session workers inherit the server environment.
export function serverDir(name: string): string {
  return join(serversDir(), assertBotName(name));
}

export function logsDir(): string {
  return join(stateRoot(), "logs");
}

export function logPath(name: string): string {
  return join(logsDir(), `${assertBotName(name)}.log`);
}

export function locksDir(): string {
  return join(stateRoot(), "locks");
}

export function lockPath(name: string): string {
  return join(locksDir(), `${assertBotName(name)}.lock`);
}

// The pi source checkout that runs the experimental server and client.
export function sourceDir(): string {
  return process.env.PI_SOURCE_DIR ?? join(homedir(), "dev", "pi");
}

export function routesDir(): string {
  return join(stateRoot(), "routes");
}

export function sessionsDir(): string {
  return join(stateRoot(), "sessions");
}

export function routePath(name: string): string {
  return join(routesDir(), `${assertBotName(name)}.json`);
}

export function sessionPath(name: string): string {
  return join(sessionsDir(), `${assertBotName(name)}.json`);
}

