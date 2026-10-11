import { createReadStream, existsSync, rmSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { extname, join, resolve, sep } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  BotError,
  archiveBot,
  clearApplyMarker,
  createBot,
  deleteBot,
  ensureInvariants,
  readBot,
  unarchiveBot,
  updateBot,
  type CreateBotInput,
  type ThinkingLevel,
  type UpdateBotInput,
} from "@apiary/pi-manager";
import {
  AuthError,
  AuthService,
  type AuthEvent,
  type AuthPromptRequest,
  type AuthType,
  type LoginHandle,
} from "@apiary/auth";
import { sharedAgentDir } from "@apiary/pi-manager";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { applyPendingReload, resolveAttach, stopServer, type AttachTarget } from "./launcher.ts";
import { isValidBotName, lockPath, logPath, serverDir } from "./paths.ts";
import { clearRoute, listBots, readRoute, type BotInfo } from "./registry.ts";
import { clearSession, isValidSessionId, readSession } from "./sessions.ts";

// The bridge is the only web-facing process. It reads the connector state files
// for the bot list and relays one WebSocket per session to the bot's unix
// socket. Bytes pass through untouched; everything above them is the pi
// protocol, which is the browser client's business.

export interface BridgeLauncher {
  resolveAttach(name: string, options?: { new?: boolean; sessionId?: string }): Promise<AttachTarget>;
}

export interface BridgeOptions {
  readonly port: number;
  readonly host?: string;
  /** Static app directory; defaults to packages/web/dist. */
  readonly webDir?: string;
  /** Overridable for tests; the default spawns real servers. */
  readonly launcher?: BridgeLauncher;
  /** Overridable for tests; the default logs into the shared agent dir. */
  readonly auth?: () => Promise<AuthService>;
}

export interface Bridge {
  readonly host: string;
  readonly port: number;
  close(): Promise<void>;
}

export async function startBridge(options: BridgeOptions): Promise<Bridge> {
  const launcher = options.launcher ?? { resolveAttach };
  const webDir = resolve(options.webDir ?? join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "web", "dist"));
  const wss = new WebSocketServer({ noServer: true });
  const authLogins = new Map<string, AuthLogin>();
  // Sessions currently relaying per bot: the apply watcher only stops a server
  // that is idle, and defers the reload to the next attach otherwise.
  const activeRelays = new Map<string, number>();
  let authService: Promise<AuthService> | undefined;
  const getAuthService = options.auth ?? (() => {
    authService ??= AuthService.create({
      authPath: join(sharedAgentDir(), "auth.json"),
      modelsPath: join(sharedAgentDir(), "models.json"),
      allowModelNetwork: true,
    });
    return authService;
  });
  const server = createServer((request, response) => {
    void routeRequest(request, response, webDir, getAuthService, authLogins).catch((error: unknown) =>
      sendApiError(response, error),
    );
  });
  server.on("upgrade", (request, socket, head) => {
    void handleUpgrade(request, socket, head, launcher, wss, authLogins, activeRelays);
  });

  const applyWatcher = startApplyWatcher(activeRelays);

  const host = options.host ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : options.port;

  return {
    host,
    port,
    async close() {
      clearInterval(applyWatcher);
      for (const client of wss.clients) client.terminate();
      wss.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

const BODY_LIMIT_BYTES = 64 * 1024;
const BOT_ROUTE = /^\/api\/bots\/([^/]+)(?:\/(archive|unarchive|stop|reload))?$/;
const AUTH_LOGIN_ROUTE = /^\/api\/auth\/login\/([0-9a-f-]{36})$/;
const AUTH_LOGIN_TTL_MS = 60_000;
const APPLY_POLL_MS = 1_000;

type GetAuthService = () => Promise<AuthService>;

type AuthFrame =
  | { type: "notify"; event: AuthEvent }
  | { type: "prompt"; prompt: AuthPromptRequest }
  | { type: "done" }
  | { type: "error"; message: string };

interface AuthLogin {
  handle: LoginHandle;
  socket?: WebSocket;
  timer?: NodeJS.Timeout;
}

/** An HTTP failure with the status the client should see. */
class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  webDir: string,
  getAuthService: GetAuthService,
  authLogins: Map<string, AuthLogin>,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://bridge");

  if (url.pathname === "/api/auth/providers") {
    if (request.method !== "GET") throw new HttpError(405, "method not allowed");
    sendJson(response, 200, { providers: (await getAuthService()).providers() });
    return;
  }

  if (url.pathname === "/api/auth/login") {
    if (request.method !== "POST") throw new HttpError(405, "method not allowed");
    const body = objectBody(await readJsonBody(request));
    const provider = stringField(body, "provider", true)!;
    const type = authTypeField(body);
    const handle = (await getAuthService()).startLogin(provider, type);
    const record: AuthLogin = { handle };
    authLogins.set(handle.id, record);
    handle.done.then(
      () => finishAuthLogin(authLogins, record, { type: "done" }),
      (error: unknown) => finishAuthLogin(authLogins, record, { type: "error", message: messageOf(error) }),
    );
    record.timer = setTimeout(() => {
      handle.abort();
      authLogins.delete(handle.id);
    }, AUTH_LOGIN_TTL_MS);
    record.timer.unref();
    sendJson(response, 201, { loginId: handle.id });
    return;
  }

  if (url.pathname === "/api/auth/logout") {
    if (request.method !== "POST") throw new HttpError(405, "method not allowed");
    const body = objectBody(await readJsonBody(request));
    const provider = stringField(body, "provider", true)!;
    await (await getAuthService()).logout(provider);
    sendEmpty(response, 204);
    return;
  }

  if (url.pathname === "/api/bots") {
    if (request.method === "GET") {
      sendJson(response, 200, { bots: listBots({ includeArchived: true }).map(summarizeBot) });
      return;
    }
    if (request.method === "POST") {
      sendJson(response, 201, { bot: await createBot(createInput(await readJsonBody(request))) });
      return;
    }
    throw new HttpError(405, "method not allowed");
  }

  const match = BOT_ROUTE.exec(url.pathname);
  if (match) {
    const name = decodeURIComponent(match[1]!);
    const action = match[2];
    if (action === undefined) {
      if (request.method === "GET") {
        sendJson(response, 200, { bot: readBot(name) });
        return;
      }
      if (request.method === "PATCH") {
        sendJson(response, 200, { bot: await updateBot(name, updateInput(await readJsonBody(request))) });
        return;
      }
      if (request.method === "DELETE") {
        const body = objectBody(await readJsonBody(request));
        const confirm = stringField(body, "confirm", true)!;
        readBot(name);
        await stopServer(name);
        deleteBot(name, { confirm });
        clearRoute(name);
        clearSession(name);
        rmSync(lockPath(name), { force: true });
        rmSync(logPath(name), { force: true });
        rmSync(serverDir(name), { recursive: true, force: true });
        sendEmpty(response, 204);
        return;
      }
      throw new HttpError(405, "method not allowed");
    }
    readBot(name);
    if (action === "archive") {
      await stopServer(name);
      sendJson(response, 200, { bot: archiveBot(name) });
      return;
    }
    if (action === "unarchive") {
      sendJson(response, 200, { bot: unarchiveBot(name) });
      return;
    }
    if (action === "reload") {
      // Stop and reconcile now, even mid-session: this is the explicit action.
      const bot = readBot(name);
      await stopServer(name);
      await ensureInvariants(name);
      clearApplyMarker(bot.dir);
      sendJson(response, 200, { bot: readBot(name) });
      return;
    }
    sendJson(response, 200, await stopServer(name));
    return;
  }

  if (request.method === "GET" || request.method === "HEAD") {
    serveStatic(request, response, webDir, url.pathname);
    return;
  }
  throw new HttpError(404, "not found");
}

function authTypeField(body: Record<string, unknown>): AuthType {
  const value = body.type;
  if (value !== "api_key" && value !== "oauth") {
    throw new HttpError(400, "'type' must be 'api_key' or 'oauth'");
  }
  return value;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pushAuthFrame(record: AuthLogin, frame: AuthFrame): void {
  const socket = record.socket;
  if (socket && socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
}

function finishAuthLogin(registry: Map<string, AuthLogin>, record: AuthLogin, frame: AuthFrame): void {
  registry.delete(record.handle.id);
  if (record.timer) clearTimeout(record.timer);
  pushAuthFrame(record, frame);
  record.socket?.close();
}

function attachAuthLogin(ws: WebSocket, record: AuthLogin, registry: Map<string, AuthLogin>): void {
  if (record.timer) clearTimeout(record.timer);
  record.socket = ws;
  try {
    record.handle.start({
      notify: (event) => pushAuthFrame(record, { type: "notify", event }),
      prompt: (prompt) => pushAuthFrame(record, { type: "prompt", prompt }),
    });
  } catch (error) {
    pushAuthFrame(record, { type: "error", message: messageOf(error) });
    registry.delete(record.handle.id);
    ws.close();
    return;
  }
  ws.on("message", (data: RawData, isBinary: boolean) => {
    if (isBinary) return;
    let message: unknown;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }
    const kind = (message as { type?: unknown }).type;
    if (kind === "abort") {
      record.handle.abort();
      return;
    }
    if (kind !== "input") return;
    const id = (message as { id?: unknown }).id;
    const value = (message as { value?: unknown }).value;
    if (typeof id !== "string" || typeof value !== "string") {
      pushAuthFrame(record, { type: "error", message: "'input' needs string id and value" });
      return;
    }
    try {
      record.handle.respond(id, value);
    } catch (error) {
      pushAuthFrame(record, { type: "error", message: messageOf(error) });
    }
  });
  ws.on("close", () => {
    record.handle.abort();
    registry.delete(record.handle.id);
  });
  ws.on("error", () => {
    record.handle.abort();
    registry.delete(record.handle.id);
  });
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > BODY_LIMIT_BYTES) throw new HttpError(413, "request body too large");
    chunks.push(buffer);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "a JSON object body is required");
  }
  return value as Record<string, unknown>;
}

function stringField(body: Record<string, unknown>, field: string, required: boolean): string | undefined {
  const value = body[field];
  if (value === undefined) {
    if (required) throw new HttpError(400, `missing '${field}'`);
    return undefined;
  }
  if (typeof value !== "string") throw new HttpError(400, `'${field}' must be a string`);
  return value;
}

function packagesField(body: Record<string, unknown>): string[] | undefined {
  const value = body.packages;
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new HttpError(400, "'packages' must be an array of strings");
  }
  return value as string[];
}

function thinkingField(body: Record<string, unknown>): ThinkingLevel | undefined {
  const value = body.thinking;
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new HttpError(400, "'thinking' must be a string");
  return value as ThinkingLevel;
}

function createInput(value: unknown): CreateBotInput {
  const body = objectBody(value);
  const name = stringField(body, "name", true)!;
  const packages = packagesField(body);
  const thinking = thinkingField(body);
  return { name, ...(packages ? { packages } : {}), ...(thinking ? { thinking } : {}) };
}

function updateInput(value: unknown): UpdateBotInput {
  const body = objectBody(value);
  const packages = packagesField(body);
  const thinking = thinkingField(body);
  return {
    ...(packages !== undefined ? { packages } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
  };
}

function statusForBotError(code: BotError["code"]): number {
  if (code === "not_found") return 404;
  if (code === "exists" || code === "conflict") return 409;
  return 400;
}

function sendApiError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  if (error instanceof HttpError) {
    sendJson(response, error.status, { error: error.message });
    return;
  }
  if (error instanceof BotError) {
    sendJson(response, statusForBotError(error.code), { error: error.message });
    return;
  }
  if (error instanceof AuthError) {
    sendJson(response, 400, { error: error.message });
    return;
  }
  sendJson(response, 500, { error: error instanceof Error ? error.message : "internal error" });
}

function serveStatic(
  request: IncomingMessage,
  response: ServerResponse,
  webDir: string,
  pathname: string,
): void {
  if (!existsSync(webDir)) {
    sendText(response, 503, "web app not built: run `bun run build` from the repo root\n");
    return;
  }
  const relative = decodeURIComponent(pathname).replace(/^\/+/, "");
  const target = resolve(webDir, relative === "" || relative.endsWith("/") ? `${relative}index.html` : relative);
  if (target !== webDir && !target.startsWith(webDir + sep)) {
    sendText(response, 404, "not found\n");
    return;
  }
  if (!existsSync(target) || statSync(target).isDirectory()) {
    sendText(response, 404, "not found\n");
    return;
  }
  const size = statSync(target).size;
  response.writeHead(200, { "content-type": contentType(target), "content-length": size });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  createReadStream(target).pipe(response);
}

function contentType(path: string): string {
  switch (extname(path)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json";
    case ".map":
      return "application/json";
    case ".svg":
      return "image/svg+xml";
    case ".ico":
      return "image/x-icon";
    default:
      return "application/octet-stream";
  }
}

function sendText(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8", "content-length": Buffer.byteLength(body) });
  response.end(body);
}

function summarizeBot(bot: BotInfo): Record<string, unknown> {
  const route = readRoute(bot.name);
  const session = readSession(bot.name);
  return {
    name: bot.name,
    dir: bot.dir,
    archived: bot.archived,
    setup: bot.setup,
    apply: bot.apply,
    running: route !== undefined,
    serverId: route?.serverId ?? null,
    pid: route?.pid ?? null,
    startedAt: route?.startedAt ?? null,
    lastSession:
      session === undefined ? null : { sessionId: session.sessionId, updatedAt: session.updatedAt },
  };
}

async function handleUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  launcher: BridgeLauncher,
  wss: WebSocketServer,
  authLogins: Map<string, AuthLogin>,
  activeRelays: Map<string, number>,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://bridge");

  const authMatch = AUTH_LOGIN_ROUTE.exec(url.pathname);
  if (authMatch) {
    const record = authLogins.get(authMatch[1]!);
    if (!record) {
      rejectUpgrade(socket, 404, "unknown login");
      return;
    }
    try {
      wss.handleUpgrade(request, socket, head, (ws) => attachAuthLogin(ws, record, authLogins));
    } catch {
      socket.destroy();
    }
    return;
  }

  if (url.pathname !== "/ws") {
    rejectUpgrade(socket, 404, "not found");
    return;
  }
  const bot = url.searchParams.get("bot") ?? "";
  if (!isValidBotName(bot)) {
    rejectUpgrade(socket, 400, "invalid bot name");
    return;
  }
  const session = url.searchParams.get("session");
  if (session !== null && !isValidSessionId(session)) {
    rejectUpgrade(socket, 400, "invalid session id");
    return;
  }

  let target: AttachTarget;
  try {
    // Starts the bot's server when it is not running, like `apiary attach`.
    target = await launcher.resolveAttach(bot, session === null ? {} : { sessionId: session });
  } catch (error) {
    rejectUpgrade(socket, 502, error instanceof Error ? error.message : "could not start the bot");
    return;
  }
  if (socket.destroyed) return;
  try {
    wss.handleUpgrade(request, socket, head, (ws) => relay(ws, target, activeRelays));
  } catch {
    socket.destroy();
  }
}

/**
 * Poll every bot for the post-commit apply marker. A bot with live sessions is
 * left alone: its next attach applies the pending reload. Idle bots stop and
 * reconcile immediately.
 */
function startApplyWatcher(activeRelays: Map<string, number>): NodeJS.Timeout {
  let sweeping = false;
  const timer = setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    void sweepApplyMarkers(activeRelays)
      .catch((error: unknown) => {
        console.error(`apiary: apply sweep failed: ${messageOf(error)}`);
      })
      .finally(() => {
        sweeping = false;
      });
  }, APPLY_POLL_MS);
  timer.unref();
  return timer;
}

async function sweepApplyMarkers(activeRelays: Map<string, number>): Promise<void> {
  for (const bot of listBots()) {
    if (bot.archived || (activeRelays.get(bot.name) ?? 0) > 0) continue;
    try {
      await applyPendingReload(bot.name);
    } catch (error) {
      console.error(`apiary: reload of '${bot.name}' failed: ${messageOf(error)}`);
    }
  }
}

function relay(ws: WebSocket, target: AttachTarget, activeRelays: Map<string, number>): void {
  const upstream = connect(target.socketPath);
  let closed = false;
  activeRelays.set(target.bot, (activeRelays.get(target.bot) ?? 0) + 1);
  const shutdown = (): void => {
    if (closed) return;
    closed = true;
    const remaining = (activeRelays.get(target.bot) ?? 1) - 1;
    if (remaining > 0) activeRelays.set(target.bot, remaining);
    else activeRelays.delete(target.bot);
    upstream.destroy();
    ws.close();
  };

  upstream.on("connect", () => {
    upstream.on("data", (chunk: Buffer) => {
      ws.send(chunk, (error) => {
        if (error) {
          shutdown();
          return;
        }
        if (upstream.isPaused()) upstream.resume();
      });
      // The ws send queue is unbounded; when a frame is still buffered, stop
      // reading the upstream socket until the send callback runs.
      if (ws.bufferedAmount > 0) upstream.pause();
    });
  });
  ws.on("message", (data: RawData, isBinary: boolean) => {
    if (!isBinary) {
      // The channel is the raw byte stream; control goes over HTTP.
      shutdown();
      return;
    }
    if (!upstream.write(rawToBuffer(data))) ws.pause();
  });
  upstream.on("drain", () => ws.resume());
  upstream.on("error", shutdown);
  upstream.on("close", shutdown);
  ws.on("error", shutdown);
  ws.on("close", shutdown);
}

function rawToBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (Buffer.isBuffer(data)) return data;
  return Buffer.from(data);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  response.end(body);
}

function sendEmpty(response: ServerResponse, status: number): void {
  response.writeHead(status);
  response.end();
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  const body = JSON.stringify({ error: message });
  socket.end(
    `HTTP/1.1 ${status} ${statusText(status)}\r\n` +
      "content-type: application/json\r\n" +
      `content-length: ${Buffer.byteLength(body)}\r\n` +
      "connection: close\r\n\r\n" +
      body,
  );
}

function statusText(status: number): string {
  if (status === 400) return "Bad Request";
  if (status === 404) return "Not Found";
  return "Bad Gateway";
}
