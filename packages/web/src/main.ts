import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type ByteTransportHandlers, Client } from "@earendil-works/pi-client";
import {
	activateBuiltinClientServices,
	type ActivatedClientRuntimeServer,
} from "@pi/fork/experimental/services/activation.ts";
import { createServerServiceSource, createSessionServiceSource } from "@pi/fork/experimental/services/connection.ts";
import { blobatarSvg } from "./blob.ts";
import { renderMarkdown } from "./markdown.ts";

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
	toolCallId?: string;
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

interface RunningTool {
	status: "running" | "settled";
	toolCallId: string;
	toolName: string;
	args: unknown;
}

interface QueuedItem {
	entryId: string;
	kind: string;
	type: string;
	message?: MessageLike;
	customType?: string;
}

interface Operation {
	id: string;
	kind: string;
	status: string;
	deferred?: unknown;
	streamingMessage?: MessageLike;
	runningTools?: RunningTool[];
}

interface TranscriptSnapshot {
	lane: string;
	transcript: Entry[];
	operation: Operation | null;
	queues?: QueuedItem[];
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
const stopButton = mustFind<HTMLButtonElement>("#stop");
const compactButton = mustFind<HTMLButtonElement>("#compact");
const newButton = mustFind<HTMLButtonElement>("#new");
const latestButton = mustFind<HTMLButtonElement>("#latest");

let active: ActiveSession | undefined;
let bots: BotSummary[] = [];
// True while the open session has a running turn; drives the sidebar marker.
let laneBusy = false;
// The reader is at the end and wants new output to pull the view down.
let following = true;

// The transcript is appended to, never rebuilt, so <details> stay open, the
// streaming caret keeps blinking, and new entries can animate in. Compaction
// and session switches replace the list and go through the rebuild path.
let renderedIds: string[] = [];
const toolSteps = new Map<string, HTMLDetailsElement>();
const liveSlot = document.createElement("div");
liveSlot.className = "live";
let live: {
	shape: string;
	text?: { element: HTMLElement; source: string };
	thinking?: { element: HTMLElement; source: string };
} = { shape: "" };

// No prompt until a session is attached and hydrated.
promptInput.disabled = true;
sendButton.disabled = true;
resetTranscript();
updateLatest();

function mustFind<T extends Element>(selector: string): T {
	const element = document.querySelector<T>(selector);
	if (element === null) throw new Error(`missing element ${selector}`);
	return element;
}

// The session header holds the one live blobatar; its gaze driver has to be
// stopped whenever the header is rebuilt.
let liveBlobatarStop: (() => void) | undefined;

function setSessionTitle(bot?: string, sessionId?: string): void {
	liveBlobatarStop?.();
	liveBlobatarStop = undefined;
	sessionTitle.replaceChildren();
	if (bot === undefined || sessionId === undefined) {
		sessionTitle.textContent = "no session";
		return;
	}
	const blob = blobatarSvg(bot, "avatar title-blob", true);
	liveBlobatarStop = blob.stop;
	const name = document.createElement("span");
	name.className = "title-name";
	name.textContent = bot;
	const id = document.createElement("span");
	id.className = "title-id";
	id.textContent = sessionId.slice(0, 8);
	sessionTitle.append(blob.element, name, id);
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
		const busy = bot.name === active?.bot && laneBusy;
		item.className = bot.name === active?.bot ? "active" : "";
		item.title = bot.dir;

		const meta = document.createElement("div");
		meta.className = "bot-meta";

		const open = document.createElement("button");
		open.className = "bot-name";
		open.textContent = bot.name;
		open.onclick = () => void openBot(bot.name, false);

		const state = document.createElement("span");
		state.className = busy ? "bot-state busy" : bot.running ? "bot-state running" : "bot-state";
		state.textContent = busy ? "running a turn" : bot.running ? "server running" : "idle";

		meta.append(open, state);

		const fresh = document.createElement("button");
		fresh.className = "new";
		fresh.textContent = "+";
		fresh.title = "new session";
		fresh.onclick = () => void openBot(bot.name, true);

		item.append(blobatarSvg(bot.name, "avatar", false).element, meta, fresh);
		fragment.append(item);
	}
	botList.replaceChildren(fragment);
}

async function openBot(bot: string, fresh: boolean): Promise<void> {
	await closeSession();
	resetTranscript();
	updateComposer();
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
		setSessionTitle(bot, sessionId);
		following = true;
		active.unsubscribe = activated.transcript.state.subscribe((state) => {
			// A late update from a previous bot must not clobber the current view.
			if (active?.sessionId === openSessionId) renderTranscript(state.snapshot);
		});
		renderTranscript(activated.transcript.state.value?.snapshot);
		updateComposer();
		renderBots();
		promptInput.focus();
		// The attach registered this session as the bot's last one.
		void refreshBots();
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
	resetTranscript();
	setSessionTitle();
	updateComposer();
	updateLatest();
	updateActions();
	try {
		await closing.client.dispose();
	} catch {
		// the socket may already be gone
	}
}

function snapshotIsRunning(): boolean {
	return currentOperation() !== undefined;
}

// A snapshot operation is present while the lane is busy; status is "open"
// when it can still be aborted and "aborting" once the abort was requested.
function currentOperation(): Operation | undefined {
	const operation = currentSnapshot()?.operation;
	return operation === null || operation === undefined ? undefined : operation;
}

function currentSnapshot(): TranscriptSnapshot | undefined {
	return active?.activated.transcript.state.value?.snapshot as TranscriptSnapshot | null | undefined ?? undefined;
}

// Buttons only do what the lane can take: nothing while connecting, abort while
// running, compact while idle.
function updateActions(): void {
	const live = active !== undefined;
	const operation = currentOperation();
	stopButton.disabled = !live || operation?.status !== "open";
	compactButton.disabled = !live || operation !== undefined;
	newButton.disabled = !live;
	const busy = operation !== undefined;
	if (laneBusy !== busy) {
		laneBusy = busy;
		renderBots();
	}
}

function updateComposer(): void {
	const live = active !== undefined;
	promptInput.disabled = !live;
	sendButton.disabled = !live || promptInput.value.trim() === "";
	promptInput.placeholder = !live ? "Select a bot" : snapshotIsRunning() ? "Steer the agent\u2026" : `Message ${active?.bot ?? ""}`;
}

function resetTranscript(): void {
	renderedIds = [];
	toolSteps.clear();
	live = { shape: "" };
	liveSlot.replaceChildren();
	liveSlot.classList.remove("enter");
	transcriptElement.replaceChildren(liveSlot);
	transcriptElement.classList.add("empty");
	latestButton.hidden = true;
}

function scrollToBottom(smooth: boolean): void {
	transcriptElement.scrollTo({ top: transcriptElement.scrollHeight, behavior: smooth ? "smooth" : "auto" });
	following = true;
	updateLatest();
}

function isNearBottom(): boolean {
	return transcriptElement.scrollHeight - transcriptElement.scrollTop - transcriptElement.clientHeight < 80;
}

function updateLatest(): void {
	latestButton.hidden = following || active === undefined;
}

function renderTranscript(snapshot: TranscriptSnapshot | null | undefined): void {
	if (snapshot === null || snapshot === undefined) {
		setStatus("waiting for the transcript", "busy");
		return;
	}
	const stick = following;
	const entries = snapshot.transcript;
	const prefix =
		entries.length >= renderedIds.length && renderedIds.every((id, index) => entries[index]?.id === id);
	if (!prefix) {
		renderedIds = [];
		toolSteps.clear();
		transcriptElement.replaceChildren(liveSlot);
		const fragment = document.createDocumentFragment();
		for (const entry of entries) {
			const node = renderEntry(entry);
			if (node !== undefined) fragment.append(node);
		}
		transcriptElement.insertBefore(fragment, liveSlot);
	} else if (entries.length > renderedIds.length) {
		const fragment = document.createDocumentFragment();
		for (const entry of entries.slice(renderedIds.length)) {
			const node = renderEntry(entry);
			if (node !== undefined) {
				node.classList.add("enter");
				fragment.append(node);
			}
		}
		transcriptElement.insertBefore(fragment, liveSlot);
	}
	renderedIds = entries.map((entry) => entry.id);
	renderLive(snapshot);
	transcriptElement.classList.toggle("empty", renderedIds.length === 0 && liveSlot.firstElementChild === null);
	if (stick) scrollToBottom(false);
	updateLatest();
	const running = snapshot.operation !== null && snapshot.operation !== undefined;
	if (sessionStatus.className !== "error") setStatus(running ? "running" : "ready", running ? "busy" : "idle");
	updateComposer();
	updateActions();
}

function renderEntry(entry: Entry): HTMLElement | undefined {
	switch (entry.type) {
		case "message": {
			const message = entry.message;
			if (message.role === "toolResult") {
				const step = message.toolCallId === undefined ? undefined : toolSteps.get(message.toolCallId);
				if (step !== undefined) {
					attachResult(step, message);
					return undefined;
				}
				return toolResultPanel(message);
			}
			return renderMessage(message);
		}
		case "compaction":
			return systemNote("compacted", entry.summary);
		case "branch_summary":
			return systemNote("branch summary", entry.summary);
		case "custom":
			return systemNote(entry.customType, "");
		default:
			return undefined;
	}
}

function renderMessage(message: MessageLike, options: { register?: boolean } = {}): HTMLElement {
	const article = document.createElement("article");
	article.className = message.role === "user" ? "message user" : "message assistant";
	if (message.isError === true || message.stopReason === "error") article.classList.add("error");

	if (message.role === "user") {
		const bubble = document.createElement("div");
		bubble.className = "bubble";
		bubble.textContent = textOf(message);
		article.append(bubble);
		return article;
	}
	for (const block of messageBlocks(message)) {
		if (block.type === "text" && block.text.trim() !== "") {
			article.append(markdown(block.text));
		} else if (block.type === "thinking" && block.thinking.trim() !== "") {
			article.append(collapsible("thinking", block.thinking));
		} else if (block.type === "toolCall") {
			article.append(toolStep(block, false, options.register !== false));
		}
	}
	if (message.stopReason === "error" && message.errorMessage !== undefined) article.append(note(message.errorMessage));
	return article;
}

/**
 * The answer slot: what the model is writing right now, or a thinking line
 * while it has not written anything yet.
 */
function renderLive(snapshot: TranscriptSnapshot): void {
	const operation = snapshot.operation;
	const queued = queuedMessages(snapshot);
	const streaming = operation?.streamingMessage;
	const running = (operation?.runningTools ?? []).filter((tool) => tool.status === "running");
	const text = streaming === undefined ? "" : blockText(streaming, "text");
	const thinking = streaming === undefined ? "" : blockText(streaming, "thinking");
	const shape = JSON.stringify({
		id: operation?.id ?? null,
		status: operation?.status ?? null,
		deferred: operation?.deferred !== undefined,
		queued: queued.map((item) => item.entryId),
		blocks: messageBlocks(streaming).map((block) => block.type),
		running: running.map((tool) => tool.toolCallId),
		streaming: streaming !== undefined,
		hasText: text.trim() !== "",
		hasThinking: thinking.trim() !== "",
	});
	if (shape === live.shape) {
		// The same nodes, with a longer answer: update the text in place so the
		// caret keeps blinking instead of restarting on every update.
		if (live.text !== undefined && text !== live.text.source) {
			live.text.source = text;
			live.text.element.innerHTML = renderMarkdown(text);
		}
		if (live.thinking !== undefined && thinking !== live.thinking.source) {
			live.thinking.source = thinking;
			live.thinking.element.textContent = thinking;
		}
		return;
	}
	live = { shape };
	const fragment = document.createDocumentFragment();
	for (const item of queued) fragment.append(queuedMessage(item));
	if (streaming !== undefined) {
		const view = liveMessage(streaming, running, operation?.deferred !== undefined);
		live.text = view.text;
		live.thinking = view.thinking;
		fragment.append(view.root);
	} else if (running.length > 0) {
		// Between messages the streaming slot is empty while tools run; the
		// snapshot still carries them.
		for (const tool of running) fragment.append(runningStep(tool));
	} else if (operation !== null && operation !== undefined) {
		fragment.append(thinkingLine(operation.deferred !== undefined));
	}
	liveSlot.replaceChildren(fragment);
	if (liveSlot.firstElementChild !== null) liveSlot.classList.add("enter");
}

function liveMessage(
	message: MessageLike,
	running: RunningTool[],
	deferred: boolean,
): {
	root: HTMLElement;
	text?: { element: HTMLElement; source: string };
	thinking?: { element: HTMLElement; source: string };
} {
	const root = document.createElement("article");
	root.className = "message assistant streaming";
	const text = blockText(message, "text");
	const thinking = blockText(message, "thinking");
	const steps: ToolCallBlock[] = messageBlocks(message).filter(isToolCall);
	const runningIds = new Set(running.map((tool) => tool.toolCallId));
	let textView: { element: HTMLElement; source: string } | undefined;
	let thinkingView: { element: HTMLElement; source: string } | undefined;
	if (text.trim() !== "") {
		const element = markdown(text);
		const cursor = document.createElement("span");
		cursor.className = "cursor";
		root.append(element, cursor);
		textView = { element, source: text };
		for (const block of steps) root.append(toolStep(block, runningIds.has(block.id), false));
		if (thinking.trim() !== "") {
			const details = collapsible("thinking", thinking);
			root.append(details);
			thinkingView = { element: details.querySelector("pre") as HTMLElement, source: thinking };
		}
	} else if (steps.length > 0 || running.length > 0) {
		root.append(thinkingLine(deferred));
		for (const block of steps) root.append(toolStep(block, runningIds.has(block.id), false));
		for (const tool of running) {
			if (steps.some((block) => block.id === tool.toolCallId)) continue;
			root.append(runningStep(tool));
		}
		if (thinking.trim() !== "") {
			const details = collapsible("thinking", thinking);
			root.append(details);
			thinkingView = { element: details.querySelector("pre") as HTMLElement, source: thinking };
		}
	} else {
		root.append(thinkingLine(deferred));
		if (thinking.trim() !== "") {
			const details = collapsible("thinking", thinking);
			root.append(details);
			thinkingView = { element: details.querySelector("pre") as HTMLElement, source: thinking };
		}
	}
	return { root, text: textView, thinking: thinkingView };
}

function toolStep(block: ToolCallBlock, running: boolean, register: boolean): HTMLDetailsElement {
	const details = document.createElement("details");
	details.className = running ? "step tool running" : "step tool";
	const summary = document.createElement("summary");
	summary.append(running ? spinner() : bullet());
	const name = document.createElement("span");
	name.className = "step-name";
	name.textContent = block.name;
	const text = document.createElement("span");
	text.className = "step-text";
	text.textContent = summarizeArgs(block.arguments) || "\u2026";
	summary.append(name, text);
	const args = document.createElement("pre");
	args.className = "step-block args";
	args.textContent = pretty(block.arguments);
	details.append(summary, args);
	if (register) toolSteps.set(block.id, details);
	return details;
}

function runningStep(tool: RunningTool): HTMLDetailsElement {
	const details = document.createElement("details");
	details.className = "step tool running";
	const summary = document.createElement("summary");
	const name = document.createElement("span");
	name.className = "step-name";
	name.textContent = tool.toolName;
	const text = document.createElement("span");
	text.className = "step-text";
	text.textContent = summarizeArgs(tool.args) || "\u2026";
	summary.append(spinner(), name, text);
	details.append(summary);
	return details;
}

function attachResult(step: HTMLDetailsElement, message: MessageLike): void {
	if (message.isError === true) step.classList.add("failed");
	const pre = document.createElement("pre");
	pre.className = "step-block result";
	pre.textContent = textOf(message).trim() || "(no output)";
	step.append(pre);
}

function toolResultPanel(message: MessageLike): HTMLElement {
	const article = document.createElement("article");
	article.className = message.isError === true ? "message toolResult error" : "message toolResult";
	const label = document.createElement("div");
	label.className = "tool-label";
	label.textContent = message.isError === true ? "tool error" : "tool result";
	const pre = document.createElement("pre");
	pre.className = "step-block result";
	pre.textContent = textOf(message).trim() || "(no output)";
	article.append(label, pre);
	return article;
}

function queuedMessage(item: QueuedItem): HTMLElement {
	const article = document.createElement("article");
	article.className = "message user queued";
	const bubble = document.createElement("div");
	bubble.className = "bubble";
	bubble.textContent = textOf(item.message ?? { role: "user" });
	const tag = document.createElement("span");
	tag.className = "tag";
	tag.textContent = item.kind === "steer" ? "steering" : "queued";
	bubble.append(tag);
	article.append(bubble);
	return article;
}

function thinkingLine(deferred: boolean): HTMLElement {
	const line = document.createElement("div");
	line.className = "thinking";
	line.append(document.createTextNode(deferred ? "deferred" : "thinking"));
	const dots = document.createElement("span");
	dots.className = "dots";
	for (let index = 0; index < 3; index += 1) dots.append(document.createElement("i"));
	line.append(dots);
	return line;
}

function spinner(): HTMLElement {
	const element = document.createElement("span");
	element.className = "spinner";
	element.setAttribute("aria-hidden", "true");
	return element;
}

function bullet(): HTMLElement {
	const element = document.createElement("span");
	element.className = "step-bullet";
	element.textContent = "\u2022";
	element.setAttribute("aria-hidden", "true");
	return element;
}

function markdown(source: string): HTMLElement {
	const element = document.createElement("div");
	element.className = "text markdown";
	element.innerHTML = renderMarkdown(source);
	return element;
}

function collapsible(label: string, body: string): HTMLDetailsElement {
	const details = document.createElement("details");
	details.className = "step thinking-step";
	const summary = document.createElement("summary");
	summary.append(bullet());
	const name = document.createElement("span");
	name.className = "step-name";
	name.textContent = label;
	summary.append(name);
	const pre = document.createElement("pre");
	pre.className = "step-block";
	pre.textContent = body;
	details.append(summary, pre);
	return details;
}

function systemNote(label: string, summary: string): HTMLElement {
	const aside = document.createElement("details");
	aside.className = "note";
	const head = document.createElement("summary");
	head.textContent = label;
	aside.append(head);
	if (summary !== "") {
		const body = document.createElement("pre");
		body.className = "step-block";
		body.textContent = summary;
		aside.append(body);
	}
	return aside;
}

function note(text: string): HTMLElement {
	const aside = document.createElement("div");
	aside.className = "note error-note";
	aside.textContent = text;
	return aside;
}

function queuedMessages(snapshot: TranscriptSnapshot): QueuedItem[] {
	return (snapshot.queues ?? []).filter(
		(item) => item.type === "message" && (item.kind === "steer" || item.kind === "followUp"),
	);
}

function messageBlocks(message: MessageLike | undefined): ContentBlock[] {
	return message !== undefined && Array.isArray(message.content) ? message.content : [];
}

function isToolCall(block: ContentBlock): block is ToolCallBlock {
	return block.type === "toolCall";
}

function blockText(message: MessageLike, type: "text" | "thinking"): string {
	const parts: string[] = [];
	for (const block of messageBlocks(message)) {
		if (type === "text" && block.type === "text") parts.push(block.text);
		else if (type === "thinking" && block.type === "thinking") parts.push(block.thinking);
	}
	return parts.join(type === "text" ? "\n" : "\n\n");
}

function textOf(message: MessageLike): string {
	return blockText(message, "text");
}

/** One line of a tool call, in the CLI's `bash: ls -la` shape. */
function summarizeArgs(args: unknown): string {
	if (args === null || typeof args !== "object") return typeof args === "string" ? singleLine(args) : "";
	const record = args as Record<string, unknown>;
	const first = record.command ?? record.path ?? record.pattern ?? record.query ?? Object.values(record)[0];
	return typeof first === "string" ? singleLine(first) : "";
}

function singleLine(text: string, max = 100): string {
	const line = text.split("\n").find((part) => part.trim() !== "")?.trim() ?? "";
	return line.length > max ? `${line.slice(0, max)}\u2026` : line;
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

function autogrow(): void {
	promptInput.style.height = "auto";
	promptInput.style.height = `${Math.min(promptInput.scrollHeight, 200)}px`;
}

/** Text still in the lane queues, handed back to the composer on abort. */
function restoreQueued(): void {
	const snapshot = currentSnapshot();
	const dropped = queuedMessages(snapshot ?? ({ transcript: [], operation: null } as TranscriptSnapshot))
		.map((item) => textOf(item.message ?? { role: "user" }).trim())
		.filter((text) => text !== "");
	if (dropped.length === 0) return;
	const text = dropped.join("\n\n");
	promptInput.value = promptInput.value.trim() === "" ? text : `${text}\n\n${promptInput.value}`;
	autogrow();
	updateComposer();
}

promptForm.addEventListener("submit", (event) => {
	event.preventDefault();
	const text = promptInput.value.trim();
	const session = active;
	if (text === "" || session === undefined) return;
	const request = { message: text, images: null };
	promptInput.value = "";
	autogrow();
	updateComposer();
	scrollToBottom(true);
	// While a turn runs the message steers it; otherwise it starts a turn.
	const call = snapshotIsRunning()
		? session.activated.agent.steer(request, BACKGROUND_CONTEXT)
		: session.activated.agent.prompt(request, BACKGROUND_CONTEXT);
	void call.then(
		(response) => {
			if (response.accepted) {
				updateComposer();
				return;
			}
			promptInput.value = text;
			setStatus(response.error.message, "error");
			updateComposer();
		},
		(error: unknown) => {
			promptInput.value = text;
			setStatus(message(error), "error");
			updateComposer();
		},
	);
});

promptInput.addEventListener("input", () => {
	autogrow();
	updateComposer();
});

promptInput.addEventListener("keydown", (event) => {
	if (event.key === "Enter" && !event.shiftKey) {
		event.preventDefault();
		promptForm.requestSubmit();
	}
});

transcriptElement.addEventListener("scroll", () => {
	following = isNearBottom();
	updateLatest();
});

latestButton.addEventListener("click", () => scrollToBottom(true));
refreshButton.addEventListener("click", () => void refreshBots());
window.addEventListener("focus", () => void refreshBots());

stopButton.addEventListener("click", () => {
	const session = active;
	const operation = currentOperation();
	if (session === undefined || operation === undefined) return;
	restoreQueued();
	stopButton.disabled = true;
	setStatus("aborting", "busy");
	void session.activated.agent.requestAbort(operation.id, BACKGROUND_CONTEXT).catch((error: unknown) => {
		setStatus(message(error), "error");
		updateActions();
	});
});

compactButton.addEventListener("click", () => {
	const session = active;
	if (session === undefined) return;
	compactButton.disabled = true;
	setStatus("compacting", "busy");
	void session.activated.agent.compact({ customInstructions: null }, BACKGROUND_CONTEXT).then(
		(response) => {
			if (!response.accepted || response.error !== null) {
				setStatus(response.error?.message ?? "compact failed", "error");
			} else if (sessionStatus.className === "error") {
				setStatus("ready", "idle");
			}
			updateActions();
		},
		(error: unknown) => {
			setStatus(message(error), "error");
			updateActions();
		},
	);
});

newButton.addEventListener("click", () => {
	if (active === undefined) return;
	void openBot(active.bot, true);
});

await refreshBots();
