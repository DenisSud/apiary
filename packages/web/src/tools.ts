import { type MessageLike, type RunningTool, type ToolCallBlock, textOf } from "./types.ts";

// Tool rows: the icon-led line for one tool call, its quiet state glyph (a
// spinner while running, a check when done, a triangle only on error), the
// duration on hover, and the result block. The rows registry pairs a call
// with its result whatever the order the transcript delivers them in.

export interface ToolRows {
	/** The row for a tool call; a result that already arrived attaches here. */
	step(block: ToolCallBlock, running: boolean): HTMLDetailsElement;
	/** The row for a tool the snapshot reports without a transcript message. */
	running(tool: RunningTool): HTMLDetailsElement;
	/** Attach a result to its row, or hand back an orphan panel to place. */
	result(message: MessageLike, duration?: string): HTMLElement | undefined;
	clear(): void;
}

export function createToolRows(): ToolRows {
	const steps = new Map<string, HTMLDetailsElement>();
	const results = new Map<string, MessageLike>();

	const step = (block: ToolCallBlock, running: boolean): HTMLDetailsElement => {
		const details = document.createElement("details");
		details.className = "step tool";
		const summary = document.createElement("summary");
		const name = document.createElement("span");
		name.className = "step-name";
		name.textContent = block.name;
		const text = document.createElement("span");
		text.className = "step-text";
		text.textContent = summarizeArgs(block.arguments) || "\u2026";
		summary.append(toolIcon(block.name), name, text, ...stepTrail());
		const args = document.createElement("pre");
		args.className = "step-block args";
		args.textContent = pretty(block.arguments);
		details.append(summary, args);
		stepState(details, running ? "running" : "pending");
		steps.set(block.id, details);
		const cached = results.get(block.id);
		if (cached !== undefined) attach(details, cached);
		return details;
	};

	const running = (tool: RunningTool): HTMLDetailsElement => {
		const details = document.createElement("details");
		details.className = "step tool";
		const summary = document.createElement("summary");
		const name = document.createElement("span");
		name.className = "step-name";
		name.textContent = tool.toolName;
		const text = document.createElement("span");
		text.className = "step-text";
		text.textContent = summarizeArgs(tool.args) || "\u2026";
		summary.append(toolIcon(tool.toolName), name, text, ...stepTrail());
		details.append(summary);
		stepState(details, tool.status === "running" ? "running" : "pending");
		if (tool.status === "settled") attach(details, toolResultMessage(tool));
		return details;
	};

	const result = (message: MessageLike, duration?: string): HTMLElement | undefined => {
		if (message.toolCallId !== undefined) results.set(message.toolCallId, message);
		const step = message.toolCallId === undefined ? undefined : steps.get(message.toolCallId);
		if (step === undefined) return toolResultPanel(message);
		attach(step, message, duration);
		return undefined;
	};

	return {
		step,
		running,
		result,
		clear(): void {
			steps.clear();
			results.clear();
		},
	};
}

function attach(step: HTMLDetailsElement, message: MessageLike, duration?: string): void {
	stepState(step, message.isError === true ? "error" : "done", duration);
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

/** The snapshot's settled tool result as a message the rows can read. */
function toolResultMessage(tool: RunningTool): MessageLike {
	const content = (tool.result as { content?: unknown } | undefined)?.content;
	const text = Array.isArray(content)
		? content
				.map((block) =>
					block !== null && typeof block === "object" && typeof (block as { text?: unknown }).text === "string"
						? (block as { text: string }).text
						: "",
				)
				.join("\n")
		: "";
	return { role: "toolResult", isError: tool.isError, content: [{ type: "text", text }] };
}

// Quiet state glyphs: a check when it is done, a triangle only when it failed.
const STATUS_ICONS: Record<string, string> = {
	check: '<path d="M20 6 9 17l-5-5"/>',
	alert:
		'<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 20h16a2 2 0 0 0 1.73-2Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
};

function stepState(
	step: HTMLDetailsElement,
	state: "running" | "pending" | "done" | "error",
	duration?: string,
): void {
	step.classList.toggle("running", state === "running");
	step.classList.toggle("error", state === "error");
	const dur = step.querySelector(".step-dur");
	if (dur !== null && duration !== undefined) dur.textContent = duration;
	const holder = step.querySelector(".step-state");
	if (holder === null) return;
	holder.replaceChildren();
	if (state === "running") {
		const ring = document.createElement("span");
		ring.className = "step-spin";
		holder.append(ring);
	} else if (state === "done" || state === "error") {
		holder.innerHTML = `<svg ${SVG_ATTRS}>${STATUS_ICONS[state === "done" ? "check" : "alert"]}</svg>`;
	}
}

/** How long a tool took, in the trace's hover label. */
export function stepDuration(ms: number): string {
	const seconds = Math.max(0.1, ms / 1000);
	return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
}

/** The trailing pair of every tool row: hover duration, then the state glyph. */
function stepTrail(): HTMLElement[] {
	const dur = document.createElement("span");
	dur.className = "step-dur";
	const state = document.createElement("span");
	state.className = "step-state";
	return [dur, state];
}

/** The tool's glyph: one per standard tool, the general wrench otherwise. */
function toolIcon(tool: string): HTMLElement {
	const glyph = document.createElement("span");
	glyph.className = "step-icon";
	glyph.innerHTML = `<svg ${SVG_ATTRS}>${iconFor(tool)}</svg>`;
	return glyph;
}

const SVG_ATTRS =
	'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';

/** One icon per standard tool; anything else gets the general wrench. */
const ICONS: Record<string, string> = {
	bash: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
	read: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M16 13H8"/><path d="M16 17H8"/>',
	write:
		'<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
	edit: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
	ls: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
	grep: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
	glob: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
	find: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
	web: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
	general:
		'<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
};

function iconFor(tool: string): string {
	if (tool in ICONS) return ICONS[tool];
	if (tool.startsWith("web")) return ICONS.web;
	return ICONS.general;
}

/** One line of a tool call, in the CLI's `bash: ls -la` shape. */
export function summarizeArgs(args: unknown): string {
	if (args === null || typeof args !== "object") return typeof args === "string" ? singleLine(args) : "";
	const record = args as Record<string, unknown>;
	const first = record.command ?? record.path ?? record.pattern ?? record.query ?? Object.values(record)[0];
	return typeof first === "string" ? singleLine(first) : "";
}

export function singleLine(text: string, max = 100): string {
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
