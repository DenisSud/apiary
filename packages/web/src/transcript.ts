import { renderMarkdown } from "./markdown.ts";
import { type SkillInvocation, parseSkillInvocation } from "./skill-block.ts";
import { createStream, type Stream } from "./stream.ts";
import { createToolRows } from "./tools.ts";
import {
	type Block,
	type Bubble,
	type TracePiece,
	type Turn,
	blockSignature,
	groupBubbles,
	groupEntries,
	turnPieces,
} from "./turns.ts";
import { type MessageLike, type QueuedItem, type TranscriptSnapshot, queuedMessages, textOf } from "./types.ts";

// The transcript view: one lane snapshot in, DOM out. Grouping entries into
// turns, the live working bubbles, the streaming answer and the incremental
// append-only rendering all live behind render()/reset(). Working traces are
// temporary: a bubble shows the trace while the model works, collapses the
// moment its message arrives, and the settled turn keeps only the messages.

export interface TranscriptView {
	render(snapshot: TranscriptSnapshot): void;
	reset(): void;
	/** True for a <details> the view opened itself, not the reader. */
	ownsToggle(target: EventTarget | null): boolean;
}

const EASE = "cubic-bezier(0.2, 0, 0, 1)";
const COLLAPSE_MS = 140;

/** One live bubble of the running turn: its trace while working, its text after. */
interface LiveBubble {
	key: string;
	element: HTMLElement;
	bubble: HTMLElement;
	label?: Text;
	trace?: HTMLDetailsElement;
	traceBody?: HTMLElement;
	traceSig?: string;
	text?: Stream;
	textSource?: string;
	thinking: Map<string, { details: HTMLDetailsElement; pre: HTMLPreElement }>;
}

export function createTranscript(root: HTMLElement): TranscriptView {
	const rows = createToolRows();
	const liveSlot = document.createElement("div");
	liveSlot.className = "live";
	const queuedHost = document.createElement("div");
	queuedHost.className = "live-queued";
	const bubbleHost = document.createElement("div");
	bubbleHost.className = "live-bubbles";
	liveSlot.append(queuedHost, bubbleHost);
	// Details we open ourselves still queue a toggle event once inserted; those
	// must not count as the reader folding something away.
	const openedByUs = new WeakSet<Element>();
	// The transcript is appended to, never rebuilt, so <details> stay open and
	// new entries can animate in. Compaction and session switches replace the
	// list and go through the reset path.
	let renderedGroups: string[] = [];
	let renderedNodes: (HTMLElement | undefined)[] = [];
	let queuedSig = "";
	const liveBubbles: LiveBubble[] = [];

	const reducedMotion = (): boolean => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

	const refreshEmpty = (): void => {
		root.classList.toggle(
			"empty",
			renderedGroups.length === 0 && queuedHost.childElementCount === 0 && bubbleHost.childElementCount === 0,
		);
	};

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
		refreshEmpty();
	};

	const reset = (): void => {
		renderedGroups = [];
		renderedNodes = [];
		rows.clear();
		queuedSig = "";
		liveBubbles.length = 0;
		queuedHost.replaceChildren();
		bubbleHost.replaceChildren();
		liveSlot.replaceChildren(queuedHost, bubbleHost);
		root.replaceChildren(liveSlot);
		root.classList.add("empty");
	};

	/* ---------- settled blocks ---------- */

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

	/** One settled assistant turn: only the messages; the traces are gone. */
	const renderTurn = (turn: Turn): HTMLElement | undefined => {
		const bubbles = groupBubbles(turnPieces(turn, undefined, [])).filter((bubble) => bubble.text !== "");
		const errors: string[] = [];
		for (const entry of turn.entries) {
			const message = entry.message;
			if (message.stopReason === "error" && message.errorMessage !== undefined) errors.push(message.errorMessage);
		}
		if (bubbles.length === 0 && errors.length === 0) return undefined;
		const article = document.createElement("article");
		article.className = "message assistant";
		for (const bubble of bubbles) {
			const box = document.createElement("div");
			box.className = "bubble";
			box.append(markdown(bubble.text));
			article.append(box);
		}
		for (const error of errors) article.append(note(error));
		return article;
	};

	const renderMessage = (message: MessageLike): HTMLElement => {
		const article = document.createElement("article");
		article.className = "message user";
		if (message.isError === true || message.stopReason === "error") article.classList.add("error");
		const bubble = document.createElement("div");
		bubble.className = "bubble";
		const text = textOf(message);
		const skill = parseSkillInvocation(text);
		if (skill === null) {
			bubble.textContent = text;
		} else {
			bubble.append(skillChip(skill));
			if (skill.args !== undefined) {
				const args = document.createElement("div");
				args.className = "skill-args";
				args.textContent = skill.args;
				bubble.append(args);
			}
		}
		article.append(bubble);
		return article;
	};

	/** A skill invocation: the name in a chip, its description on hover. */
	const skillChip = (skill: SkillInvocation): HTMLElement => {
		const chip = document.createElement("span");
		chip.className = "skill-chip";
		chip.append(document.createTextNode(skill.name));
		if (skill.description !== undefined) {
			const tip = document.createElement("span");
			tip.className = "skill-tip";
			tip.textContent = skill.description;
			chip.append(tip);
		}
		return chip;
	};

	/* ---------- the live bubbles ---------- */

	const renderLive = (snapshot: TranscriptSnapshot): void => {
		const operation = snapshot.operation;
		const queued = queuedMessages(snapshot);
		const nextQueuedSig = queued.map((item) => item.entryId).join(",");
		if (nextQueuedSig !== queuedSig) {
			queuedSig = nextQueuedSig;
			queuedHost.replaceChildren(...queued.map(queuedMessage));
		}
		if (operation === null || operation === undefined) {
			clearBubbles();
			return;
		}
		const blocks = groupEntries(snapshot.transcript);
		const last = blocks.length > 0 ? blocks[blocks.length - 1] : undefined;
		const turn = last !== undefined && last.kind === "turn" ? last.turn : undefined;
		const deferred = operation.deferred !== undefined;
		const bubbles = groupBubbles(turnPieces(turn, operation.streamingMessage, operation.runningTools ?? []));
		for (let index = 0; index < bubbles.length; index += 1) {
			const bubble = bubbles[index];
			let live = liveBubbles[index];
			if (live === undefined || live.key !== bubble.key) {
				for (const stale of liveBubbles.splice(index)) stale.element.remove();
				live = createLiveBubble(bubble, deferred);
				liveBubbles.push(live);
			}
			updateLiveBubble(live, bubble, deferred);
		}
		while (liveBubbles.length > bubbles.length) liveBubbles.pop()?.element.remove();
	};

	const createLiveBubble = (bubble: Bubble, deferred: boolean): LiveBubble => {
		const article = document.createElement("article");
		article.className = "message assistant streaming";
		article.classList.add("enter");
		const box = document.createElement("div");
		box.className = "bubble";
		article.append(box);
		bubbleHost.append(article);
		const live: LiveBubble = { key: bubble.key, element: article, bubble: box, thinking: new Map() };
		if (bubble.text === "") {
			attachTrace(live);
			updateTrace(live, bubble, deferred);
		} else {
			live.text = createStream();
			live.textSource = bubble.text;
			live.text.update(bubble.text);
			box.append(live.text.wrap);
		}
		return live;
	};

	const updateLiveBubble = (live: LiveBubble, bubble: Bubble, deferred: boolean): void => {
		if (bubble.text !== "" && live.text === undefined) {
			// The model started writing: the trace collapses, the message takes the bubble.
			collapseTrace(live);
			live.text = createStream();
			live.textSource = bubble.text;
			live.text.update(bubble.text);
			live.bubble.append(live.text.wrap);
			return;
		}
		if (live.text !== undefined && bubble.text !== live.textSource) {
			live.textSource = bubble.text;
			live.text.update(bubble.text);
		}
		if (bubble.text === "") {
			if (live.trace === undefined) attachTrace(live);
			updateTrace(live, bubble, deferred);
		}
	};

	const attachTrace = (live: LiveBubble): void => {
		const details = document.createElement("details");
		details.className = "trace live";
		openByUs(details);
		const summary = document.createElement("summary");
		const label = document.createTextNode("Working");
		const spinner = document.createElement("span");
		spinner.className = "jump-ring";
		summary.append(label, spinner);
		const body = document.createElement("div");
		body.className = "trace-body";
		details.append(summary, body);
		live.label = label;
		live.trace = details;
		live.traceBody = body;
		live.traceSig = undefined;
		live.bubble.append(details);
	};

	const updateTrace = (live: LiveBubble, bubble: Bubble, deferred: boolean): void => {
		if (live.traceBody === undefined) return;
		const signature = traceSignature(bubble.trace, deferred);
		if (signature === live.traceSig) return;
		live.traceSig = signature;
		if (live.label !== undefined) live.label.nodeValue = deferred ? "Waiting" : "Working";
		const nodes: HTMLElement[] = [];
		for (const piece of bubble.trace) {
			const node = traceNode(live, piece);
			if (node !== undefined) nodes.push(node);
		}
		live.traceBody.replaceChildren(...nodes);
	};

	/** Rebuild only when the trace really changed; thinking grows in place. */
	const traceSignature = (pieces: readonly TracePiece[], deferred: boolean): string =>
		pieces
			.map((piece) => {
				if (piece.kind === "thinking") return `t:${piece.id}:${piece.text.length}`;
				if (piece.kind === "toolCall") return `c:${piece.id}:${piece.running}`;
				if (piece.kind === "toolLive") return `l:${piece.id}:${piece.tool.status}`;
				return `r:${piece.id}`;
			})
			.join("|") + `:${deferred}`;

	const traceNode = (live: LiveBubble, piece: TracePiece): HTMLElement | undefined => {
		switch (piece.kind) {
			case "thinking": {
				const existing = live.thinking.get(piece.id);
				if (existing !== undefined) {
					existing.pre.textContent = piece.text;
					return existing.details;
				}
				const details = collapsible("thinking", piece.text);
				openByUs(details);
				live.thinking.set(piece.id, { details, pre: details.querySelector("pre") as HTMLPreElement });
				return details;
			}
			case "toolCall":
				return rows.step(piece.block, piece.running);
			case "toolResult":
				return rows.result(piece.message, piece.duration);
			case "toolLive":
				return rows.running(piece.tool);
		}
	};

	const collapseTrace = (live: LiveBubble): void => {
		const trace = live.trace;
		live.trace = undefined;
		live.traceBody = undefined;
		live.traceSig = undefined;
		if (trace === undefined) return;
		if (reducedMotion()) {
			trace.remove();
			return;
		}
		const height = trace.offsetHeight;
		trace.style.overflow = "hidden";
		const animation = trace.animate(
			[
				{ height: `${height}px`, opacity: 1 },
				{ height: "0px", opacity: 0 },
			],
			{ duration: COLLAPSE_MS, easing: EASE },
		);
		animation.onfinish = () => trace.remove();
	};

	const clearBubbles = (): void => {
		if (liveBubbles.length === 0) return;
		const last = liveBubbles[liveBubbles.length - 1];
		// A turn that ended without a message fades its trace out; one that
		// ended with messages hands over to the settled node in the same paint.
		const fade = last !== undefined && last.text === undefined && !reducedMotion();
		for (const live of liveBubbles) {
			if (live !== last || !fade) live.element.remove();
		}
		liveBubbles.length = 0;
		if (fade && last !== undefined) {
			const animation = last.element.animate([{ opacity: 1 }, { opacity: 0 }], {
				duration: COLLAPSE_MS,
				easing: EASE,
			});
			animation.onfinish = () => {
				last.element.remove();
				refreshEmpty();
			};
		}
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
