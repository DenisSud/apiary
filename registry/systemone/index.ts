/**
 * systemone — decision-model middleware at pi lifecycle points.
 *
 * Currently one point is implemented: a pre-tool risk guard. Tool calls for
 * the configured tools are classified by a local System One endpoint (the
 * TypeSafe wire format; Kev is the reference server); a call whose risk
 * probability crosses the threshold is blocked before execution.
 *
 * Without ~/.pi/agent/systemone.json the extension registers nothing. See
 * README.md for the config, the wire protocol and the failure semantics.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DecisionClient, loadConfig, type DecisionConfig } from "@pi-bots/systemone";
import { AUTHORIZED_QUESTION_ID, DANGER_QUESTION_ID, blockedReason, buildGuardState, guardQuestions, shouldBlock } from "./guard.ts";

/** Consecutive classifier failures before the guard backs off (fail-open mode only). */
const FAILURES_TO_TRIP = 3;
/** How long the guard stays backed off after tripping. */
const COOLDOWN_MS = 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Text of a session message, handling both string and content-part content. */
function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (isRecord(part) && part.type === "text" && typeof part.text === "string") parts.push(part.text);
	}
	return parts.join("\n");
}

export default function systemoneExtension(pi: ExtensionAPI) {
	const config: DecisionConfig | null = loadConfig();
	if (!config) return;
	const guard = config.guard;
	if (!guard.enabled) return;

	const client = new DecisionClient(config);
	const userMessages: string[] = [];
	let seeded = false;
	let failures = 0;
	let cooldownUntil = 0;
	let notified = false;

	const remember = (text: string): void => {
		const trimmed = text.trim();
		if (!trimmed) return;
		userMessages.push(trimmed.slice(0, guard.contextChars));
		while (userMessages.length > guard.contextMessages) userMessages.shift();
	};

	const seedFromSession = (ctx: ExtensionContext): void => {
		if (seeded) return;
		seeded = true;
		try {
			for (const message of ctx.sessionManager.buildSessionProjection().messages) {
				if (message.role === "user") remember(messageText(message.content));
			}
		} catch {
			// No session loaded yet; input events will fill the buffer.
		}
	};

	pi.on("session_start", (_event, ctx) => {
		userMessages.length = 0;
		seeded = false;
		seedFromSession(ctx);
	});

	pi.on("input", (event) => {
		remember(event.text);
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!guard.tools.includes(event.toolName)) return;
		if (cooldownUntil > Date.now()) return;

		const state = buildGuardState({ userMessages, toolName: event.toolName, input: event.input });
		try {
			const answers = await client.classify(state, guardQuestions(), ctx.signal);
			failures = 0;
			notified = false;
			const danger = answers[DANGER_QUESTION_ID]?.probability ?? 0;
			const authorized = answers[AUTHORIZED_QUESTION_ID]?.probability ?? 0;
			if (shouldBlock(danger, authorized, guard.threshold, guard.authorizedThreshold)) {
				return {
					block: true as const,
					reason: blockedReason(event.toolName, danger, authorized, guard.threshold, guard.authorizedThreshold, guard.blockedMessage),
				};
			}
			return;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (guard.onError === "closed") {
				return { block: true as const, reason: `systemone guard failed closed: ${message}. Classifier: ${config.baseUrl}.` };
			}
			if (ctx.signal?.aborted) return;
			failures += 1;
			if (failures >= FAILURES_TO_TRIP) {
				failures = 0;
				cooldownUntil = Date.now() + COOLDOWN_MS;
			}
			if (!notified) {
				notified = true;
				ctx.ui.notify(`systemone guard: classifier unavailable (${message}); tool calls are not being checked.`, "warning");
			}
			return;
		}
	});
}
