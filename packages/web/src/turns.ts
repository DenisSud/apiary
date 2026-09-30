import { stepDuration } from "./tools.ts";
import {
	type Entry,
	type MessageEntry,
	type MessageLike,
	type RunningTool,
	type ToolCallBlock,
	isToolCall,
	messageBlocks,
} from "./types.ts";

// The transcript's pure structure: entries grouped into turns, a turn split
// into pieces at message boundaries, pieces grouped into the bubbles the view
// renders. Traces are temporary — a bubble pairs the work with the message it
// produced; the view drops the trace the moment the text arrives.

/** A turn is everything the assistant did between two user messages. */
export interface Turn {
	entries: MessageEntry[];
	startedAt?: number;
	endedAt?: number;
}

export type Block =
	| { kind: "user"; entry: MessageEntry }
	| { kind: "turn"; turn: Turn }
	| { kind: "note"; entry: Exclude<Entry, MessageEntry> };

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

export function blockSignature(block: Block, tailRunning: boolean): string {
	if (block.kind === "user") return `user:${block.entry.id}`;
	if (block.kind === "note") return `note:${block.entry.id}`;
	const ids = block.turn.entries.map((entry) => entry.id).join(",");
	return `turn:${ids}:${tailRunning ? "running" : "settled"}`;
}

/* ---------- pieces ---------- */

/** One block-level item of a turn, in the order the model produced it. */
export type TracePiece =
	| { kind: "thinking"; id: string; text: string }
	| { kind: "toolCall"; id: string; block: ToolCallBlock; running: boolean }
	| { kind: "toolResult"; id: string; message: MessageLike; duration?: string }
	| { kind: "toolLive"; id: string; tool: RunningTool };

export type Piece = TracePiece | { kind: "text"; id: string; text: string };

/**
 * Flatten a turn (and the streaming message, when a turn runs) into pieces.
 * A message carrying text and tool calls yields both: the text ends one
 * bubble, the calls open the next.
 */
export function turnPieces(
	turn: Turn | undefined,
	streaming: MessageLike | undefined,
	tools: readonly RunningTool[],
): Piece[] {
	const running = new Set(tools.filter((tool) => tool.status === "running").map((tool) => tool.toolCallId));
	const covered = new Set<string>();
	const callTimes = new Map<string, number>();
	const pieces: Piece[] = [];

	const addMessage = (prefix: string, message: MessageLike, timestamp?: number): void => {
		if (message.role === "toolResult") {
			const started = message.toolCallId === undefined ? undefined : callTimes.get(message.toolCallId);
			const duration =
				started === undefined || timestamp === undefined ? undefined : stepDuration(timestamp - started);
			pieces.push({ kind: "toolResult", id: prefix, message, ...(duration === undefined ? {} : { duration }) });
			return;
		}
		messageBlocks(message).forEach((block, index) => {
			if (block.type === "thinking" && block.thinking.trim() !== "") {
				pieces.push({ kind: "thinking", id: `${prefix}:${index}`, text: block.thinking });
			} else if (block.type === "text" && block.text.trim() !== "") {
				pieces.push({ kind: "text", id: `${prefix}:${index}`, text: block.text });
			} else if (isToolCall(block)) {
				covered.add(block.id);
				if (timestamp !== undefined) callTimes.set(block.id, timestamp);
				pieces.push({ kind: "toolCall", id: block.id, block, running: running.has(block.id) });
			}
		});
	};

	if (turn !== undefined) {
		for (const entry of turn.entries) addMessage(entry.id, entry.message, entry.timestamp);
	}
	if (streaming !== undefined) addMessage("streaming", streaming);
	for (const tool of tools) {
		if (!covered.has(tool.toolCallId)) pieces.push({ kind: "toolLive", id: tool.toolCallId, tool });
	}
	return pieces;
}

/* ---------- bubbles ---------- */

/** The work of one phase and the message it produced, if any. */
export interface Bubble {
	key: string;
	trace: TracePiece[];
	text: string;
}

/**
 * Group pieces into bubbles: a trace piece after a message opens a new
 * bubble; text always lands in the current one. So a bubble reads as
 * [trace] → [the message the trace produced], and only the last bubble of a
 * running turn can still be trace-only.
 */
export function groupBubbles(pieces: readonly Piece[]): Bubble[] {
	const bubbles: Bubble[] = [];
	let current: Bubble | undefined;
	const start = (piece: Piece): Bubble => {
		const bubble: Bubble = { key: piece.id, trace: [], text: "" };
		bubbles.push(bubble);
		return bubble;
	};
	for (const piece of pieces) {
		if (piece.kind === "text") {
			current ??= start(piece);
			current.text = current.text === "" ? piece.text : `${current.text}\n\n${piece.text}`;
			continue;
		}
		if (current === undefined || current.text !== "") current = start(piece);
		current.trace.push(piece);
	}
	return bubbles;
}
