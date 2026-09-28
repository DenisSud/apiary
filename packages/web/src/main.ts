import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type ByteTransportHandlers, Client } from "@earendil-works/pi-client";
import {
	activateBuiltinClientServices,
	type ActivatedClientRuntimeServer,
} from "@pi/fork/experimental/services/activation.ts";
import { createServerServiceSource, createSessionServiceSource } from "@pi/fork/experimental/services/connection.ts";

// Minimal browser client for the connector bridge. One WebSocket carries one
// session's byte stream to the bot's pi server; everything above it uses the
// same client stack as the TUI (Client + Chord service facades).

interface BotSummary {
	name: string;
	dir: string;
	running: boolean;
	serverId: string | null;
	pid: number | null;
	startedAt: string | null;
	lastSession: { sessionId: string; updatedAt: string } | null;
}

interface TextBlock {
	type: "text";
	text: string;
}
interface ThinkingBlock {
	type: "thinking";
	thinking: string;
}
interface ToolCallBlock {
	type: "toolCall";
	id: string;
	name: string;
	arguments: unknown;
}
type ContentBlock = TextBlock | ThinkingBlock | ToolCallBlock | { type: string };

interface MessageLike {
	role: string;
	content?: ContentBlock[];
	isError?: boolean;
	stopReason?: string;
	errorMessage?: string;
}

interface MessageEntry {
	type: "message";
	id: string;
	message: MessageLike;
}
interface CompactionEntry {
	type: "compaction";
	id: string;
	summary: string;
}
interface BranchSummaryEntry {
	type: "branch_summary";
	id: string;
	summary: string;
}
interface CustomEntry {
	type: "custom";
	id: string;
	customType: string;
}
type Entry = MessageEntry | CompactionEntry | BranchSummaryEntry | CustomEntry;

interface TranscriptSnapshot {
	lane: string;
	transcript: Entry[];
	operation: { id: string; kind: string; status: string; streamingMessage?: MessageLike } | null;
	configuration?: { model?: { provider: string; modelId: string }; thinkingLevel?: string };
	stats?: { messageCount?: number };
}

interface ActiveSession {
	bot: string;
	sessionId: string;
	serverId: string;
	client: Client;
	activated: ActivatedClientRuntimeServer;
	ws: WebSocket;
	unsubscribe: () => void;
}

const botList = mustFind<HTMLUListElement>("#bot-list");
const refreshButton = mustFind<HTMLButtonElement>("#refresh");
const sessionTitle = mustFind<HTMLSpanElement>("#session-title");
const sessionStatus = mustFind<HTMLSpanElement>("#session-status");
const transcriptElement = mustFind<HTMLElement>("#transcript");
const promptForm = mustFind<HTMLFormElement>("#prompt-form");
const promptInput = mustFind<HTMLTextAreaElement>("#prompt");
const sendButton = mustFind<HTMLButtonElement>("#send");

let active: ActiveSession | undefined;
let bots: BotSummary[] = [];

// No prompt until a session is attached and hydrated.
promptInput.disabled = true;
sendButton.disabled = true;

function mustFind<T extends Element>(selector: string): T {
	const element = document.querySelector<T>(selector);
	if (element === null) throw new Error(`missing element ${selector}`);
	return element;
}

async function fetchBots(): Promise<BotSummary[]> {
	const response = await fetch("/api/bots");
	if (!response.ok) throw new Error(`/api/bots: ${response.status}`);
	return ((await response.json()) as { bots: BotSummary[] }).bots;
}

function bridgeUrl(path: string): string {
	const scheme = location.protocol === "https:" ? "wss" : "ws";
	return `${scheme}://${location.host}${path}`;
}

function setStatus(text: string, kind: "idle" | "busy" | "error" = "idle"): void {
	sessionStatus.textContent = text;
	sessionStatus.className = kind;
}

async function refreshBots(): Promise<void> {
	try {
		bots = await fetchBots();
	} catch (error) {
		setStatus(message(error), "error");
		return;
	}
	renderBots();
}

function renderBots(): void {
	const fragment = document.createDocumentFragment();
	for (const bot of bots) {
		const item = document.createElement("li");
		item.className = bot.name === active?.bot ? "active" : "";
		item.title = bot.dir;

		const open = document.createElement("button");
		open.className = "bot-name";
		open.textContent = bot.name;
		open.onclick = () => void openBot(bot.name, false);

		const state = document.createElement("span");
		state.className = bot.running ? "dot running" : "dot";
		state.textContent = bot.running ? "running" : "stopped";

		const fresh = document.createElement("button");
		fresh.className = "new";
		fresh.textContent = "+";
		fresh.title = "new session";
		fresh.onclick = () => void openBot(bot.name, true);

		item.append(open, state, fresh);
		fragment.append(item);
	}
	botList.replaceChildren(fragment);
}

async function openBot(bot: string, fresh: boolean): Promise<void> {
	await closeSession();
	promptInput.disabled = true;
	sendButton.disabled = true;
	setStatus("connecting", "busy");
	try {
		const summary = bots.find((candidate) => candidate.name === bot);
		if (summary === undefined) throw new Error(`unknown bot ${bot}`);
		const sessionId = fresh || summary.lastSession === null ? crypto.randomUUID() : summary.lastSession.sessionId;
		const openSessionId = sessionId;

		const ws = new WebSocket(bridgeUrl(`/ws?bot=${encodeURIComponent(bot)}&session=${sessionId}`));
		ws.binaryType = "arraybuffer";
		await new Promise<void>((resolve, reject) => {
			ws.onopen = () => resolve();
			ws.onerror = () => reject(new Error("bridge upgrade failed"));
		});

		// The upgrade starts the bot's server, so the route exists by now.
		const started = await fetchBots();
		bots = started;
		const serverId = started.find((candidate) => candidate.name === bot)?.serverId;
		if (serverId === null || serverId === undefined) throw new Error(`bot ${bot} has no server route`);

		const client = await Client.connect({ serverId, transportFactory: browserTransport(ws) });
		const server = createServerServiceSource(client);
		const session = createSessionServiceSource(client);
		const activated = await activateBuiltinClientServices({
			route: { transport: "unix", serverId, path: "bridge" },
			client,
			server,
			session,
		});
		const known = activated.directory.state.value?.sessions.some((entry) => entry.sessionId === sessionId) ?? false;
		if (!known) await activated.management.create({ id: sessionId }, BACKGROUND_CONTEXT);
		await activated.management.attach(sessionId, BACKGROUND_CONTEXT);

		active = { bot, sessionId, serverId, client, activated, ws, unsubscribe: () => {} };
		sessionTitle.textContent = `${bot} / ${sessionId.slice(0, 8)}`;
		active.unsubscribe = activated.transcript.state.subscribe((state) => {
			// A late update from a previous bot must not clobber the current view.
			if (active?.sessionId === openSessionId) renderTranscript(state.snapshot);
		});
		setStatus(snapshotIsRunning() ? "running" : "ready");
		renderBots();
		promptInput.focus();
	} catch (error) {
		setStatus(message(error), "error");
	}
}

/**
 * ByteTransport over one bridge WebSocket. Sends are fire-and-forget: the
 * browser API offers no completion signal, and pi frames are small.
 */
function browserTransport(ws: WebSocket) {
	return async (handlers: ByteTransportHandlers) => {
		ws.onmessage = (event) => handlers.onData(new Uint8Array(event.data as ArrayBuffer));
		ws.onclose = () => handlers.onClose();
		ws.onerror = () => handlers.onError(new Error("bridge websocket error"));
		return {
			async send(chunk: Uint8Array): Promise<void> {
				if (ws.readyState !== WebSocket.OPEN) throw new Error("bridge websocket is closed");
				ws.send(chunk);
			},
			close(): void {
				ws.close();
			},
		};
	};
}

async function closeSession(): Promise<void> {
	if (active === undefined) return;
	const closing = active;
	active = undefined;
	closing.unsubscribe();
	closing.ws.close();
	promptInput.disabled = true;
	sendButton.disabled = true;
	try {
		await closing.client.dispose();
	} catch {
		// the socket may already be gone
	}
	transcriptElement.replaceChildren();
	sessionTitle.textContent = "no session";
}

function snapshotIsRunning(): boolean {
	return active?.activated.transcript.state.value?.snapshot?.operation?.status === "running";
}

function renderTranscript(snapshot: TranscriptSnapshot | null | undefined): void {
	if (snapshot === null || snapshot === undefined) {
		setStatus("waiting for the transcript", "busy");
		return;
	}
	const stick = isNearBottom();
	const fragment = document.createDocumentFragment();
	for (const entry of snapshot.transcript) {
		const rendered = renderEntry(entry);
		if (rendered !== undefined) fragment.append(rendered);
	}
	const streaming = snapshot.operation?.streamingMessage;
	if (streaming !== undefined) fragment.append(renderMessage(streaming, true));
	transcriptElement.replaceChildren(fragment);
	if (stick) transcriptElement.scrollTop = transcriptElement.scrollHeight;
	const running = snapshot.operation !== null && snapshot.operation.status === "running";
	setStatus(running ? "running" : "ready", running ? "busy" : "idle");
	sendButton.disabled = running;
	promptInput.disabled = running;
}

function isNearBottom(): boolean {
	return transcriptElement.scrollHeight - transcriptElement.scrollTop - transcriptElement.clientHeight < 80;
}

function renderEntry(entry: Entry): HTMLElement | undefined {
	switch (entry.type) {
		case "message":
			return renderMessage(entry.message, false);
		case "compaction":
			return note("compaction", entry.summary);
		case "branch_summary":
			return note("branch summary", entry.summary);
		case "custom":
			return note(entry.customType, "");
		default:
			return undefined;
	}
}

function renderMessage(message: MessageLike, streaming: boolean): HTMLElement {
	const article = document.createElement("article");
	const classes = ["message", message.role];
	if (message.isError === true || (message.stopReason !== undefined && message.stopReason === "error")) {
		classes.push("error");
	}
	if (streaming) classes.push("streaming");
	article.className = classes.join(" ");

	const role = document.createElement("div");
	role.className = "role";
	role.textContent = message.role;
	article.append(role);

	const content = Array.isArray(message.content) ? message.content : [];
	for (const block of content) {
		if (block.type === "text") {
			const text = document.createElement("div");
			text.className = "text";
			text.textContent = block.text;
			article.append(text);
		} else if (block.type === "thinking") {
			article.append(collapsible("thinking", block.thinking));
		} else if (block.type === "toolCall") {
			article.append(collapsible(`tool call: ${block.name}`, pretty(block.arguments)));
		} else if (block.type === "image") {
			article.append(note("image", ""));
		}
	}
	if (message.stopReason === "error" && message.errorMessage !== undefined) {
		article.append(note("error", message.errorMessage));
	}
	return article;
}

function collapsible(label: string, body: string): HTMLElement {
	const details = document.createElement("details");
	const summary = document.createElement("summary");
	summary.textContent = label;
	const pre = document.createElement("pre");
	pre.textContent = body;
	details.append(summary, pre);
	return details;
}

function note(label: string, body: string): HTMLElement {
	const aside = document.createElement("div");
	aside.className = "note";
	const strong = document.createElement("strong");
	strong.textContent = label;
	aside.append(strong, body === "" ? "" : ` ${body}`);
	return aside;
}

function pretty(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2) ?? "";
	} catch {
		return String(value);
	}
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

promptForm.addEventListener("submit", (event) => {
	event.preventDefault();
	const text = promptInput.value.trim();
	if (text === "" || active === undefined) return;
	promptInput.value = "";
	sendButton.disabled = true;
	promptInput.disabled = true;
	void active.activated.agent.prompt({ message: text, images: null }, BACKGROUND_CONTEXT).then(
		(response) => {
			if (!response.accepted) setStatus(response.error.message, "error");
		},
		(error: unknown) => setStatus(message(error), "error"),
	);
});

promptInput.addEventListener("keydown", (event) => {
	if (event.key === "Enter" && !event.shiftKey) {
		event.preventDefault();
		promptForm.requestSubmit();
	}
});

refreshButton.addEventListener("click", () => void refreshBots());
window.addEventListener("focus", () => void refreshBots());

await refreshBots();
