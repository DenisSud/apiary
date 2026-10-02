// The vocabulary the bridge hands the app: bot summaries and lane snapshots
// (entries, messages, content blocks, queues), plus the small readers that
// make the snapshot usable. Everything here is plain data and pure accessors.

export interface BotSummary {
	name: string;
	dir: string;
	archived: boolean;
	/** True while the agent still has to finish its `init` commit. */
	setup: boolean;
	/** True while a post-commit apply marker waits for a reload. */
	apply: boolean;
	running: boolean;
	serverId: string | null;
	pid: number | null;
	startedAt: string | null;
	lastSession: { sessionId: string; updatedAt: string } | null;
}

/** The management view of one bot: what create and detail return. */
export interface BotDetail {
	name: string;
	dir: string;
	archived: boolean;
	setup: boolean;
	packages: string[];
	model: { provider: string; id: string };
	thinking?: string;
}

export interface TextBlock {
	type: "text";
	text: string;
}
export interface ThinkingBlock {
	type: "thinking";
	thinking: string;
}
export interface ToolCallBlock {
	type: "toolCall";
	id: string;
	name: string;
	arguments: unknown;
}
export type ContentBlock = TextBlock | ThinkingBlock | ToolCallBlock | { type: string };

export interface MessageLike {
	role: string;
	content?: ContentBlock[];
	isError?: boolean;
	stopReason?: string;
	errorMessage?: string;
	toolCallId?: string;
}

export interface MessageEntry {
	type: "message";
	id: string;
	timestamp?: number;
	message: MessageLike;
}
export interface CompactionEntry {
	type: "compaction";
	id: string;
	timestamp?: number;
	summary: string;
}
export interface BranchSummaryEntry {
	type: "branch_summary";
	id: string;
	timestamp?: number;
	summary: string;
}
export interface CustomEntry {
	type: "custom";
	id: string;
	timestamp?: number;
	customType: string;
}
export type Entry = MessageEntry | CompactionEntry | BranchSummaryEntry | CustomEntry;

export interface RunningTool {
	status: "running" | "settled";
	toolCallId: string;
	toolName: string;
	args: unknown;
	result?: unknown;
	isError?: boolean;
}

export interface QueuedItem {
	entryId: string;
	kind: string;
	type: string;
	message?: MessageLike;
	customType?: string;
}

export interface Operation {
	id: string;
	kind: string;
	status: string;
	deferred?: unknown;
	streamingMessage?: MessageLike;
	runningTools?: RunningTool[];
}

export interface TranscriptSnapshot {
	lane: string;
	transcript: Entry[];
	operation: Operation | null;
	queues?: QueuedItem[];
	configuration?: { model?: { provider: string; modelId: string }; thinkingLevel?: string };
	stats?: { messageCount?: number };
}

export function messageBlocks(message: MessageLike | undefined): ContentBlock[] {
	return message !== undefined && Array.isArray(message.content) ? message.content : [];
}

export function isToolCall(block: ContentBlock): block is ToolCallBlock {
	return block.type === "toolCall";
}

/** All text (or thinking) blocks of one message, joined. */
export function blockText(message: MessageLike, type: "text" | "thinking"): string {
	const parts: string[] = [];
	for (const block of messageBlocks(message)) {
		if (type === "text" && block.type === "text") parts.push(block.text);
		else if (type === "thinking" && block.type === "thinking") parts.push(block.thinking);
	}
	return parts.join(type === "text" ? "\n" : "\n\n");
}

export function textOf(message: MessageLike): string {
	return blockText(message, "text");
}

/** The steer/follow-up messages still waiting in the lane's queues. */
export function queuedMessages(snapshot: TranscriptSnapshot): QueuedItem[] {
	return (snapshot.queues ?? []).filter(
		(item) => item.type === "message" && (item.kind === "steer" || item.kind === "followUp"),
	);
}
