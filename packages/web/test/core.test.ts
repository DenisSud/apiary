import assert from "node:assert/strict";
import { test } from "node:test";
import { pinnedAfterScroll } from "../src/scroll.ts";
import { stepDuration, summarizeArgs, singleLine } from "../src/tools.ts";
import { groupBubbles, groupEntries, turnPieces } from "../src/turns.ts";
import { type Entry, type MessageLike, type TranscriptSnapshot, blockText, queuedMessages, textOf } from "../src/types.ts";

// The pure core: transcript grouping, the readers over a snapshot, the small
// formatters. Everything here crosses a module's interface — no DOM involved.

const message = (id: string, role: string, timestamp: number, content: MessageLike["content"] = []): Entry => ({
	type: "message",
	id,
	timestamp,
	message: { role, content },
});

test("groupEntries folds assistant work into the turn a user message opened", () => {
	const entries: Entry[] = [
		message("u1", "user", 100, [{ type: "text", text: "hello" }]),
		message("a1", "assistant", 200, [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } }]),
		message("r1", "toolResult", 300, [{ type: "text", text: "ok" }]),
		message("a2", "assistant", 400, [{ type: "text", text: "done" }]),
		{ type: "compaction", id: "c1", timestamp: 500, summary: "summarised" },
		message("u2", "user", 600, [{ type: "text", text: "again" }]),
		message("a3", "assistant", 700, [{ type: "text", text: "sure" }]),
	];
	const blocks = groupEntries(entries);
	assert.deepEqual(
		blocks.map((block) => block.kind),
		["user", "turn", "note", "user", "turn"],
	);
	const turn = blocks[1];
	assert.equal(turn.kind, "turn");
	if (turn.kind !== "turn") return;
	assert.deepEqual(
		turn.turn.entries.map((entry) => entry.id),
		["a1", "r1", "a2"],
	);
	// the turn is timed from the question, not from the first answer
	assert.equal(turn.turn.startedAt, 100);
	assert.equal(turn.turn.endedAt, 400);
	const second = blocks[4];
	assert.equal(second.kind === "turn" ? second.turn.startedAt : undefined, 600);
});

test("groupEntries keeps a note between turns from opening a turn of its own", () => {
	const blocks = groupEntries([message("u1", "user", 1), { type: "custom", id: "x", customType: "hint" }]);
	assert.deepEqual(
		blocks.map((block) => block.kind),
		["user", "note"],
	);
});

test("turnPieces flattens a turn into thinking, tool and text pieces in order", () => {
	const turn = {
		entries: [
			message("a1", "assistant", 200, [
				{ type: "thinking", thinking: "hmm" },
				{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } },
			]),
			message("r1", "toolResult", 300, [{ type: "text", text: "ok" }]),
			message("a2", "assistant", 400, [{ type: "text", text: "done" }]),
		],
	};
	// the result pairs with its call by toolCallId, like the real transcript
	turn.entries[1].message.toolCallId = "t1";
	const pieces = turnPieces(turn, undefined, []);
	assert.deepEqual(
		pieces.map((piece) => piece.kind),
		["thinking", "toolCall", "toolResult", "text"],
	);
	const result = pieces[2];
	assert.equal(result.kind === "toolResult" ? result.duration : undefined, "0.1s");
});

test("groupBubbles pairs a trace with the message it produced and splits on a message", () => {
	const turn = {
		entries: [
			message("a1", "assistant", 100, [
				{ type: "text", text: "Let me check." },
				{ type: "toolCall", id: "t1", name: "bash", arguments: {} },
			]),
			message("r1", "toolResult", 150, [{ type: "text", text: "ok" }]),
			message("a2", "assistant", 200, [{ type: "text", text: "Done." }]),
		],
	};
	const bubbles = groupBubbles(turnPieces(turn, undefined, []));
	assert.deepEqual(
		bubbles.map((bubble) => ({ trace: bubble.trace.map((piece) => piece.kind), text: bubble.text })),
		[
			{ trace: [], text: "Let me check." },
			{ trace: ["toolCall", "toolResult"], text: "Done." },
		],
	);
});

test("groupBubbles keeps a trailing trace out of the message's bubble", () => {
	const pieces = turnPieces(undefined, { role: "assistant", content: [{ type: "text", text: "hi" }] }, [
		{ status: "running", toolCallId: "t9", toolName: "bash", args: {} },
	]);
	const bubbles = groupBubbles(pieces);
	assert.deepEqual(
		bubbles.map((bubble) => ({ trace: bubble.trace.length, text: bubble.text })),
		[
			{ trace: 0, text: "hi" },
			{ trace: 1, text: "" },
		],
	);
});

test("stepDuration floors at a tenth and drops the decimal past ten seconds", () => {
	assert.equal(stepDuration(400), "0.4s");
	assert.equal(stepDuration(0), "0.1s");
	assert.equal(stepDuration(12_400), "12s");
});

test("summarizeArgs picks the interesting argument and keeps it to one line", () => {
	assert.equal(summarizeArgs({ command: "ls -la\nsecond line" }), "ls -la");
	assert.equal(summarizeArgs({ path: "/tmp/a.txt" }), "/tmp/a.txt");
	assert.equal(summarizeArgs({ pattern: "swapLive" }), "swapLive");
	assert.equal(summarizeArgs({ query: "weather" }), "weather");
	assert.equal(summarizeArgs("plain string"), "plain string");
	assert.equal(summarizeArgs({ count: 3 }), "");
	assert.equal(summarizeArgs(null), "");
});

test("singleLine truncates with an ellipsis", () => {
	assert.equal(singleLine("a".repeat(120)).length, 101);
	assert.equal(singleLine("\n\n  trimmed  \n"), "trimmed");
});

test("pinnedAfterScroll reads intent: up unpins, the end repins, shrinking is not intent", () => {
	const end = { top: 900, height: 1000 };
	// a reader moving up with the content unchanged leaves the end
	assert.equal(pinnedAfterScroll(true, end, { top: 899, height: 1000 }, false), false);
	// content shrinking lowers scrollTop on its own: not the reader
	assert.equal(pinnedAfterScroll(true, end, { top: 800, height: 900 }, false), true);
	// landing at the end repins
	assert.equal(pinnedAfterScroll(false, { top: 0, height: 1000 }, { top: 900, height: 1000 }, true), true);
	// moving down but not at the end keeps the state it had
	assert.equal(pinnedAfterScroll(true, { top: 100, height: 1000 }, { top: 200, height: 1000 }, false), true);
	assert.equal(pinnedAfterScroll(false, { top: 100, height: 1000 }, { top: 200, height: 1000 }, false), false);
});

test("blockText and textOf read the message's blocks", () => {
	const reply: MessageLike = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "hmm" },
			{ type: "text", text: "first" },
			{ type: "text", text: "second" },
		],
	};
	assert.equal(textOf(reply), "first\nsecond");
	assert.equal(blockText(reply, "thinking"), "hmm");
});

test("queuedMessages keeps steer and follow-up messages only", () => {
	const snapshot = {
		transcript: [],
		operation: null,
		queues: [
			{ entryId: "1", kind: "steer", type: "message", message: { role: "user" } },
			{ entryId: "2", kind: "followUp", type: "message", message: { role: "user" } },
			{ entryId: "3", kind: "other", type: "message", message: { role: "user" } },
			{ entryId: "4", kind: "steer", type: "custom" },
		],
	} as unknown as TranscriptSnapshot;
	assert.deepEqual(
		queuedMessages(snapshot).map((item) => item.entryId),
		["1", "2"],
	);
});
