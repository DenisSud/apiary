import { renderMarkdown } from "./markdown.ts";
import { createStream, type Stream } from "./stream.ts";
import { createToolRows, stepDuration } from "./tools.ts";
import {
	type ContentBlock,
	type Entry,
	type MessageEntry,
	type MessageLike,
	type QueuedItem,
	type RunningTool,
	type TranscriptSnapshot,
	blockText,
	isToolCall,
	messageBlocks,
	queuedMessages,
	textOf,
} from "./types.ts";

// The transcript view: one lane snapshot in, DOM out. Grouping entries into
// turns, the live working block, the streaming answer, tool rows, notes and
// the incremental append-only rendering all live behind render()/reset().

export interface TranscriptView {
	render(snapshot: TranscriptSnapshot): void;
	reset(): void;
	/** True for a <details> the view opened itself, not the reader. */
	ownsToggle(target: EventTarget | null): boolean;
}

/** A turn is everything the assistant did between two user messages. */
export interface Turn {
	entries: MessageEntry[];
	startedAt?: number;
	endedAt?: number;
}

export type Block =
	| { kind: "user"; entry: MessageEntry }
	| { kind: "turn"; turn: Turn }
	| { kind: "note"; entry: Entry };

export function createTranscript(root: HTMLElement): TranscriptView {
	const rows = createToolRows();
	const liveSlot = document.createElement("div");
	liveSlot.className = "live";
	// Details we open ourselves still queue a toggle event once inserted; those
	// must not count as the reader folding something away.
	const openedByUs = new WeakSet<Element>();
	let swapTimer: number | undefined;
	// The transcript is appended to, never rebuilt, so <details> stay open and
	// new entries can animate in. Compaction and session switches replace the
	// list and go through the reset path.
	let renderedGroups: string[] = [];
	let renderedNodes: (HTMLElement | undefined)[] = [];
	let live: {
		shape: string;
		text?: Stream;
		textSource?: string;
		root?: HTMLElement;
		queuedIds?: string;
		turnIds?: string;
		thinking?: { element: HTMLPreElement; source: string };
	} = { shape: "" };

	/** A turn is everything the assistant did between two user messages. */
	const render = (snapshot: TranscriptSnapshot): void => {
		const running = snapshot.operation !== null && snapshot.operation !== undefined;
		const blocks = groupEntries(snapshot.transcript);
		// While a turn runs its block is the live working block, not a settled one.
		const liveIndex =
			running && blocks.length > 0 && blocks[blocks.length - 1].kind === "turn" ? blocks.length - 1 : -1;
		const signatures = blocks.map((block, index) => blockSignature(block, running && index === blocks.length - 1));
		let keep = 0;
		while (
			keep < renderedGroups.length &&
			keep < signatures.length &&
			renderedGroups[keep] === signatures[keep]
		) {
			keep += 1;
		}
		if (keep < renderedNodes.length) {
			for (const node of renderedNodes.slice(keep)) node?.remove();
			renderedGroups = renderedGroups.slice(0, keep);
			renderedNodes = renderedNodes.slice(0, keep);
			if (keep === 0) rows.clear();
		}
		if (keep < blocks.length) {
			const fragment = document.createDocumentFragment();
			const before = renderedGroups.length;
			for (let index = keep; index < blocks.length; index += 1) {
				const node = index === liveIndex ? undefined : renderBlock(blocks[index]);
				if (node !== undefined) {
					if (index >= before) node.classList.add("enter");
					fragment.append(node);
				}
				renderedNodes.push(node);
				renderedGroups.push(signatures[index]);
			}
			root.insertBefore(fragment, liveSlot);
		}
		renderLive(snapshot);
		root.classList.toggle("empty", blocks.length === 0 && liveSlot.firstElementChild === null);
	};

	const reset = (): void => {
		if (swapTimer !== undefined) {
			clearTimeout(swapTimer);
			swapTimer = undefined;
		}
		renderedGroups = [];
		renderedNodes = [];
		rows.clear();
		live = { shape: "" };
		liveSlot.replaceChildren();
		liveSlot.classList.remove("enter");
		root.replaceChildren(liveSlot);
		root.classList.add("empty");
	};

	/* ---------- blocks and turns ---------- */

	const renderBlock = (block: Block): HTMLElement | undefined => {
		if (block.kind === "user") return renderMessage(block.entry.message);
		if (block.kind === "turn") return renderTurn(block.turn);
		const entry = block.entry;
		switch (entry.type) {
			case "compaction":
				return systemNote("compacted", entry.summary);
			case "branch_summary":
				return systemNote("branch summary", entry.summary);
			case "custom":
				return systemNote(entry.customType, "");
			default:
				return undefined;
		}
	};

	/** One settled assistant reply: the work collapses, the message stays. */
	const renderTurn = (turn: Turn): HTMLElement | undefined => {
		const trace: HTMLElement[] = [];
		const texts: string[] = [];
		const callTimes = new Map<string, number>();
		for (const entry of turn.entries) {
			const message = entry.message;
			if (message.role === "toolResult") {
				const started = message.toolCallId === undefined ? undefined : callTimes.get(message.toolCallId);
				const duration =
					started === undefined || entry.timestamp === undefined ? undefined : stepDuration(entry.timestamp - started);
				const panel = rows.result(message, duration);
				if (panel !== undefined) trace.push(panel);
				continue;
			}
			for (const block of messageBlocks(message)) if (isToolCall(block)) callTimes.set(block.id, entry.timestamp);
			trace.push(...messageRows(message));
			const blocks = messageBlocks(message);
			const hasCalls = blocks.some(isToolCall);
			for (const block of blocks) {
				if (block.type === "text" && block.text.trim() !== "" && !hasCalls) texts.push(block.text);
			}
			if (message.stopReason === "error" && message.errorMessage !== undefined) trace.push(note(message.errorMessage));
		}
		if (trace.length === 0 && texts.length === 0) return undefined;
		const article = document.createElement("article");
		article.className = "message assistant";
		const bubble = document.createElement("div");
		bubble.className = "bubble";
		if (trace.length > 0) {
			const details = document.createElement("details");
			details.className = "trace";
			const summary = document.createElement("summary");
			summary.textContent = workedFor(turn);
			const body = document.createElement("div");
			body.className = "trace-body";
			body.append(...trace);
			details.append(summary, body);
			bubble.append(details);
		}
		for (const text of texts) bubble.append(markdown(text));
		article.append(bubble);
		return article;
	};

	/**
	 * The trace rows of one settled message: thinking, tool calls and the text
	 * the model wrote next to them (an explainer, not the answer).
	 */
	const messageRows = (
		message: MessageLike,
		runningIds?: ReadonlySet<string>,
		openReasoning = false,
	): HTMLElement[] => {
		const out: HTMLElement[] = [];
		const blocks = messageBlocks(message);
		const hasCalls = blocks.some(isToolCall);
		for (const block of blocks) {
			if (block.type === "thinking" && block.thinking.trim() !== "") {
				const details = collapsible("thinking", block.thinking);
				if (openReasoning) openByUs(details);
				out.push(details);
			} else if (block.type === "toolCall") out.push(rows.step(block, runningIds?.has(block.id) ?? false));
			else if (block.type === "text" && block.text.trim() !== "" && hasCalls) out.push(explainer(block.text));
		}
		return out;
	};

	/* ---------- the live working block ---------- */

	const renderLive = (snapshot: TranscriptSnapshot): void => {
		const operation = snapshot.operation;
		const queued = queuedMessages(snapshot);
		const streaming = operation?.streamingMessage;
		const tools = operation?.runningTools ?? [];
		const text = streaming === undefined ? "" : blockText(streaming, "text");
		const thinking = streaming === undefined ? "" : blockText(streaming, "thinking");
		const queuedIds = queued.map((item) => item.entryId).join(",");
		const blocks = groupEntries(snapshot.transcript);
		const last = blocks.length > 0 ? blocks[blocks.length - 1] : undefined;
		const turn = last !== undefined && last.kind === "turn" ? last.turn : undefined;
		const turnIds = turn === undefined ? "" : turn.entries.map((entry) => entry.id).join(",");
		const shape = JSON.stringify({
			id: operation?.id ?? null,
			status: operation?.status ?? null,
			deferred: operation?.deferred !== undefined,
			queued: queuedIds,
			turn: turnIds,
			blocks: messageBlocks(streaming).map((block) => block.type),
			tools: tools.map((tool) => `${tool.toolCallId}:${tool.status}`),
			streaming: streaming !== undefined,
			hasText: text.trim() !== "",
		});
		if (shape === live.shape) {
			// The same nodes, with more content: extend what is already rendered.
			if (live.text !== undefined && text !== live.textSource) {
				live.textSource = text;
				live.text.update(text);
			}
			if (live.thinking !== undefined && thinking !== live.thinking.source) {
				live.thinking.source = thinking;
				live.thinking.element.textContent = thinking;
			}
			return;
		}
		live.shape = shape;
		// The answer is on screen and still streaming: keep it, only the trace
		// around it changes (a full swap would blink the whole answer).
		if (
			live.text !== undefined &&
			live.root !== undefined &&
			text.trim() !== "" &&
			queuedIds === live.queuedIds &&
			turnIds === live.turnIds
		) {
			live.text.update(text);
			updateLiveTrace(live.root, turn, streaming, tools);
			return;
		}
		live.text = undefined;
		live.textSource = undefined;
		live.root = undefined;
		live.thinking = undefined;
		live.queuedIds = queuedIds;
		live.turnIds = turnIds;
		const fragment = document.createDocumentFragment();
		for (const item of queued) fragment.append(queuedMessage(item));
		if (operation !== null && operation !== undefined) {
			const view = createLiveView(turn, streaming, tools, operation.deferred !== undefined);
			live.root = view;
			fragment.append(view);
		}
		swapLive(fragment);
	};

	/**
	 * The working block: one bubble holding the whole trace of the running turn
	 * under a "Working" row, with the answer (or explainer) streaming into it.
	 */
	const createLiveView = (
		turn: Turn | undefined,
		streaming: MessageLike | undefined,
		tools: RunningTool[],
		deferred: boolean,
	): HTMLElement => {
		const article = document.createElement("article");
		article.className = "message assistant streaming";
		const bubble = document.createElement("div");
		bubble.className = "bubble";
		article.append(bubble);
		const details = document.createElement("details");
		details.className = "trace live";
		openByUs(details);
		const summary = document.createElement("summary");
		summary.append(document.createTextNode(deferred ? "Waiting" : "Working"));
		const spinner = document.createElement("span");
		spinner.className = "jump-ring";
		summary.append(spinner);
		const body = document.createElement("div");
		body.className = "trace-body";
		body.append(...traceBodyRows(turn, streaming, tools));
		details.append(summary, body);
		bubble.append(details);
		const text = streaming === undefined ? "" : blockText(streaming, "text");
		if (text.trim() !== "") {
			const stream = createStream();
			stream.update(text);
			live.text = stream;
			live.textSource = text;
			// text next to tool calls is an explainer and belongs in the trace
			const hasCalls = streaming !== undefined && messageBlocks(streaming).some(isToolCall);
			if (hasCalls) body.append(stream.wrap);
			else bubble.append(stream.wrap);
		}
		return article;
	};

	/** Everything the running turn has done so far, in order. */
	const traceBodyRows = (
		turn: Turn | undefined,
		streaming: MessageLike | undefined,
		tools: RunningTool[],
	): HTMLElement[] => {
		const out: HTMLElement[] = [];
		const runningIds = new Set(tools.filter((tool) => tool.status === "running").map((tool) => tool.toolCallId));
		const covered = new Set<string>();
		const callTimes = new Map<string, number>();
		if (turn !== undefined) {
			for (const entry of turn.entries) {
				const message = entry.message;
				if (message.role === "toolResult") {
					const started = message.toolCallId === undefined ? undefined : callTimes.get(message.toolCallId);
					const duration =
						started === undefined || entry.timestamp === undefined
							? undefined
							: stepDuration(entry.timestamp - started);
					const panel = rows.result(message, duration);
					if (panel !== undefined) out.push(panel);
					continue;
				}
				for (const block of messageBlocks(message)) {
					if (!isToolCall(block)) continue;
					covered.add(block.id);
					callTimes.set(block.id, entry.timestamp);
				}
				out.push(...messageRows(message, runningIds, true));
			}
		}
		const streamingCalls = streaming === undefined ? [] : messageBlocks(streaming).filter(isToolCall);
		for (const block of streamingCalls) covered.add(block.id);
		if (streaming !== undefined) {
			const thinking = blockText(streaming, "thinking");
			if (thinking.trim() !== "") {
				const details = collapsible("thinking", thinking);
				openByUs(details);
				out.push(details);
				live.thinking = { element: details.querySelector("pre") as HTMLPreElement, source: thinking };
			}
			for (const block of streamingCalls) out.push(rows.step(block, runningIds.has(block.id)));
		}
		for (const tool of tools) {
			if (covered.has(tool.toolCallId)) continue;
			out.push(rows.running(tool));
		}
		return out;
	};

	/** Rebuild the trace of the working block in place, keeping the answer text. */
	const updateLiveTrace = (
		view: HTMLElement,
		turn: Turn | undefined,
		streaming: MessageLike | undefined,
		tools: RunningTool[],
	): void => {
		const bubble = view.querySelector<HTMLElement>(".bubble");
		const body = bubble?.querySelector<HTMLElement>(".trace-body");
		if (bubble === null || bubble === undefined || body === null || body === undefined) return;
		live.thinking = undefined;
		body.replaceChildren(...traceBodyRows(turn, streaming, tools));
		const stream = live.text;
		if (stream === undefined) return;
		const hasCalls = streaming !== undefined && messageBlocks(streaming).some(isToolCall);
		(hasCalls ? body : bubble).append(stream.wrap);
	};

	/** Replace the live slot: the outgoing content fades out, the new fades in. */
	const swapLive = (fragment: DocumentFragment): void => {
		const place = (): void => {
			liveSlot.replaceChildren(fragment);
			for (const node of liveSlot.children) node.classList.add("enter");
		};
		const previous = [...liveSlot.children];
		if (swapTimer !== undefined) {
			clearTimeout(swapTimer);
			swapTimer = undefined;
			place();
			return;
		}
		if (previous.length === 0 || fragment.childNodes.length === 0) {
			place();
			return;
		}
		for (const node of previous) node.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140, easing: EASE });
		swapTimer = window.setTimeout(() => {
			swapTimer = undefined;
			place();
		}, 150);
	};

	/* ---------- small pieces ---------- */

	const openByUs = (details: HTMLDetailsElement): void => {
		details.open = true;
		openedByUs.add(details);
	};

	const queuedMessage = (item: QueuedItem): HTMLElement => {
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
	};

	const renderMessage = (message: MessageLike): HTMLElement => {
		const article = document.createElement("article");
		article.className = "message user";
		if (message.isError === true || message.stopReason === "error") article.classList.add("error");
		const bubble = document.createElement("div");
		bubble.className = "bubble";
		bubble.textContent = textOf(message);
		article.append(bubble);
		return article;
	};

	/** Text the model wrote while working: as clear as the final answer. */
	const explainer = (text: string): HTMLElement => {
		const row = document.createElement("div");
		row.className = "explainer markdown";
		row.innerHTML = renderMarkdown(text);
		return row;
	};

	const markdown = (source: string): HTMLElement => {
		const element = document.createElement("div");
		element.className = "text markdown";
		element.innerHTML = renderMarkdown(source);
		return element;
	};

	const collapsible = (label: string, body: string): HTMLDetailsElement => {
		const details = document.createElement("details");
		details.className = "reason-row";
		const summary = document.createElement("summary");
		const chev = document.createElement("span");
		chev.className = "chev";
		chev.textContent = "\u203a";
		const name = document.createElement("span");
		name.className = "reason-label";
		name.textContent = label;
		summary.append(chev, name);
		const pre = document.createElement("pre");
		pre.className = "rbody";
		pre.textContent = body;
		details.append(summary, pre);
		return details;
	};

	const systemNote = (label: string, summary: string): HTMLElement => {
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
	};

	const note = (text: string): HTMLElement => {
		const aside = document.createElement("div");
		aside.className = "note error-note";
		aside.textContent = text;
		return aside;
	};

	return {
		render,
		reset,
		ownsToggle: (target) => target instanceof Element && openedByUs.has(target),
	};
}

/** Group a transcript into user messages, assistant turns and system notes. */
export function groupEntries(entries: Entry[]): Block[] {
	const blocks: Block[] = [];
	let turn: Turn | undefined;
	let askedAt: number | undefined;
	const flush = (): void => {
		if (turn !== undefined) blocks.push({ kind: "turn", turn });
		turn = undefined;
	};
	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "user") {
			flush();
			askedAt = entry.timestamp;
			blocks.push({ kind: "user", entry });
			continue;
		}
		if (entry.type === "message") {
			turn ??= { entries: [] };
			turn.startedAt ??= askedAt ?? entry.timestamp;
			turn.entries.push(entry);
			if (entry.timestamp !== undefined) turn.endedAt = entry.timestamp;
			continue;
		}
		flush();
		blocks.push({ kind: "note", entry });
	}
	flush();
	return blocks;
}

function blockSignature(block: Block, tailRunning: boolean): string {
	if (block.kind === "user") return `user:${block.entry.id}`;
	if (block.kind === "note") return `note:${block.entry.id}`;
	const ids = block.turn.entries.map((entry) => entry.id).join(",");
	return `turn:${ids}:${tailRunning ? "running" : "settled"}`;
}

function workedFor(turn: Turn): string {
	const start = turn.startedAt;
	const end = turn.endedAt;
	if (start === undefined || end === undefined || end < start) return "worked";
	return `worked for ${formatDuration(end - start)}`;
}

export function formatDuration(ms: number): string {
	const seconds = Math.max(1, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds} s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes} min ${seconds % 60} s`;
}

const EASE = "cubic-bezier(0.2, 0, 0, 1)";
