/**
 * decision/client — minimal HTTP client for the System One decision protocol
 * (the TypeSafe wire format; Kev and TypeSafe both serve it).
 *
 * One request carries a state and any number of `noul` (yes/no) questions; the
 * model answers them in parallel and the answers are calibrated probabilities.
 * Nothing here sends or stores more than the state the caller built. Policy —
 * which questions to ask, what to do with the probabilities — belongs to the
 * consumer (an extension or another package).
 */
import type { DecisionConfig } from "./config.ts";

export interface NoulQuestion {
	id: string;
	instructions: string;
	criteria?: { true: string; false: string };
}

export interface NoulAnswer {
	probability: number;
	latencyMs?: number;
	requestId?: string;
}

export class DecisionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DecisionError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProbability(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * Extract a noul probability from a System One response. TypeSafe and its
 * clones wrap answers differently (`answers`, `nouls`, or the root object), so
 * accept all three shapes.
 */
export function readNoul(payload: unknown, id: string): number | null {
	if (!isRecord(payload)) return null;
	for (const container of [payload.answers, payload.nouls, payload]) {
		if (!isRecord(container)) continue;
		const answer = container[id];
		if (isProbability(answer)) return answer;
		if (isRecord(answer) && isProbability(answer.noul)) return answer.noul;
	}
	return null;
}

function abortKind(err: unknown): "timeout" | "aborted" | "other" {
	const named = err as { name?: string; cause?: { name?: string } };
	const name = named?.name ?? named?.cause?.name;
	if (name === "TimeoutError") return "timeout";
	if (name === "AbortError") return "aborted";
	return "other";
}

function errorMessage(err: unknown): string {
	if (err instanceof Error) {
		const cause = (err as { cause?: unknown }).cause;
		if (cause instanceof Error && cause.message && !err.message.includes(cause.message)) {
			return `${err.message}: ${cause.message}`;
		}
		return err.message;
	}
	return String(err);
}

export class DecisionClient {
	#config: DecisionConfig;
	#apiKey: string | undefined;

	constructor(config: DecisionConfig, env: NodeJS.ProcessEnv = process.env) {
		this.#config = config;
		this.#apiKey = config.apiKeyEnv ? env[config.apiKeyEnv] : undefined;
	}

	/** Classify a state, answering every question in one request. */
	async classify(state: unknown, questions: NoulQuestion[], signal?: AbortSignal): Promise<Record<string, NoulAnswer>> {
		const questionsBody: Record<string, unknown> = {};
		for (const question of questions) {
			questionsBody[question.id] = {
				type: "noul",
				instructions: question.instructions,
				...(question.criteria ? { criteria: question.criteria } : {}),
			};
		}
		const body = { model: this.#config.model, state, questions: questionsBody };
		const headers: Record<string, string> = { "content-type": "application/json" };
		if (this.#apiKey) headers.authorization = `Bearer ${this.#apiKey}`;
		const timeout = AbortSignal.timeout(this.#config.timeoutMs);
		const requestSignal = signal ? AbortSignal.any([timeout, signal]) : timeout;

		let response: Response;
		try {
			response = await fetch(`${this.#config.baseUrl}/v1/systemone`, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal: requestSignal,
			});
		} catch (err) {
			const kind = abortKind(err);
			if (kind === "timeout") throw new DecisionError(`timed out after ${this.#config.timeoutMs}ms`);
			if (kind === "aborted" || signal?.aborted) throw new DecisionError("aborted");
			throw new DecisionError(`request failed: ${errorMessage(err)}`);
		}

		if (!response.ok) {
			const detail = (await response.text().catch(() => "")).trim().slice(0, 200);
			throw new DecisionError(`HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
		}

		let payload: unknown;
		try {
			payload = await response.json();
		} catch (err) {
			throw new DecisionError(`response is not JSON: ${errorMessage(err)}`);
		}

		const latencyMs = isRecord(payload) && typeof payload.latency_ms === "number" ? payload.latency_ms : undefined;
		const requestId = response.headers.get("x-typesafe-request-id") ?? undefined;
		const answers: Record<string, NoulAnswer> = {};
		for (const question of questions) {
			const probability = readNoul(payload, question.id);
			if (probability === null) throw new DecisionError(`response has no noul answer for ${JSON.stringify(question.id)}`);
			answers[question.id] = {
				probability,
				...(latencyMs !== undefined ? { latencyMs } : {}),
				...(requestId !== undefined ? { requestId } : {}),
			};
		}
		return answers;
	}
}
