/**
 * decision/config — configuration for the decision layer.
 *
 * Config file: ~/.pi/agent/decision.json (override with PI_DECISION_CONFIG).
 * Consumers use their own section (`guard` today; compaction, search filters
 * and other sections land here as they are built). Without the file consumers
 * stay inert.
 *
 *   {
 *     "baseUrl": "http://127.0.0.1:8009",
 *     "model": "kev-latest",
 *     "timeoutMs": 2000,
 *     "apiKeyEnv": "SYSTEMONE_API_KEY",
 *     "guard": {
 *       "enabled": true,
 *       "tools": ["bash"],
 *       "threshold": 0.5,
 *       "authorizedThreshold": 0.7,
 *       "onError": "open",
 *       "contextMessages": 4,
 *       "contextChars": 1500,
 *       "blockedMessage": null
 *     }
 *   }
 *
 * Every field is optional. `apiKeyEnv` names the environment variable that
 * holds the bearer key, so secrets never live in the config file.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

export interface GuardConfig {
	enabled: boolean;
	tools: string[];
	threshold: number;
	authorizedThreshold: number;
	onError: "open" | "closed";
	contextMessages: number;
	contextChars: number;
	blockedMessage?: string;
}

export interface DecisionConfig {
	baseUrl: string;
	model: string;
	timeoutMs: number;
	apiKeyEnv?: string;
	guard: GuardConfig;
}

export const DEFAULT_CONFIG_PATH = join(os.homedir(), ".pi", "agent", "decision.json");

export function configPath(): string {
	return process.env.PI_DECISION_CONFIG || DEFAULT_CONFIG_PATH;
}

function fail(message: string): never {
	throw new Error(`decision: invalid config (${message})`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBaseUrl(raw: unknown): string {
	if (raw === undefined) return "http://127.0.0.1:8009";
	if (typeof raw !== "string" || !raw.trim()) fail("baseUrl must be a non-empty string");
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		fail(`baseUrl is not a valid URL: ${JSON.stringify(raw)}`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") fail(`baseUrl must be http(s), got ${url.protocol}`);
	return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

function parseGuard(raw: unknown): GuardConfig {
	if (raw !== undefined && !isRecord(raw)) fail("guard must be an object");
	const guard = (raw ?? {}) as Record<string, unknown>;

	let enabled = true;
	if (guard.enabled !== undefined) {
		if (typeof guard.enabled !== "boolean") fail("guard.enabled must be a boolean");
		enabled = guard.enabled;
	}

	let tools = ["bash"];
	if (guard.tools !== undefined) {
		if (!Array.isArray(guard.tools) || guard.tools.length === 0) fail("guard.tools must be a non-empty array");
		tools = guard.tools.map((tool) => {
			if (typeof tool !== "string" || !tool.trim()) fail("guard.tools entries must be non-empty strings");
			return tool.trim();
		});
	}

	let threshold = 0.5;
	if (guard.threshold !== undefined) {
		if (typeof guard.threshold !== "number" || !Number.isFinite(guard.threshold) || guard.threshold < 0 || guard.threshold > 1) {
			fail("guard.threshold must be a number in [0, 1]");
		}
		threshold = guard.threshold;
	}

	let authorizedThreshold = 0.7;
	if (guard.authorizedThreshold !== undefined) {
		if (
			typeof guard.authorizedThreshold !== "number" ||
			!Number.isFinite(guard.authorizedThreshold) ||
			guard.authorizedThreshold < 0 ||
			guard.authorizedThreshold > 1
		) {
			fail("guard.authorizedThreshold must be a number in [0, 1]");
		}
		authorizedThreshold = guard.authorizedThreshold;
	}

	let onError: "open" | "closed" = "open";
	if (guard.onError !== undefined) {
		if (guard.onError !== "open" && guard.onError !== "closed") fail('guard.onError must be "open" or "closed"');
		onError = guard.onError;
	}

	let contextMessages = 4;
	if (guard.contextMessages !== undefined) {
		if (!Number.isInteger(guard.contextMessages) || (guard.contextMessages as number) < 0) {
			fail("guard.contextMessages must be a non-negative integer");
		}
		contextMessages = guard.contextMessages as number;
	}

	let contextChars = 1500;
	if (guard.contextChars !== undefined) {
		if (!Number.isInteger(guard.contextChars) || (guard.contextChars as number) < 1) {
			fail("guard.contextChars must be a positive integer");
		}
		contextChars = guard.contextChars as number;
	}

	let blockedMessage: string | undefined;
	if (guard.blockedMessage !== undefined && guard.blockedMessage !== null) {
		if (typeof guard.blockedMessage !== "string" || !guard.blockedMessage.trim()) {
			fail("guard.blockedMessage must be a non-empty string");
		}
		blockedMessage = guard.blockedMessage;
	}

	return { enabled, tools, threshold, authorizedThreshold, onError, contextMessages, contextChars, ...(blockedMessage ? { blockedMessage } : {}) };
}

function parseConfig(raw: unknown): DecisionConfig {
	if (!isRecord(raw)) fail("root must be an object");
	const obj = raw;

	const baseUrl = parseBaseUrl(obj.baseUrl);

	let model = "kev-latest";
	if (obj.model !== undefined) {
		if (typeof obj.model !== "string" || !obj.model.trim()) fail("model must be a non-empty string");
		model = obj.model.trim();
	}

	let timeoutMs = 2000;
	if (obj.timeoutMs !== undefined) {
		if (typeof obj.timeoutMs !== "number" || !Number.isFinite(obj.timeoutMs) || obj.timeoutMs <= 0) {
			fail("timeoutMs must be a positive number");
		}
		timeoutMs = obj.timeoutMs;
	}

	let apiKeyEnv: string | undefined;
	if (obj.apiKeyEnv !== undefined) {
		if (typeof obj.apiKeyEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(obj.apiKeyEnv)) {
			fail("apiKeyEnv must be an environment variable name");
		}
		apiKeyEnv = obj.apiKeyEnv;
	}

	const guard = parseGuard(obj.guard);
	return { baseUrl, model, timeoutMs, apiKeyEnv, guard };
}

/** Load the config. Returns null when the config file does not exist. */
export function loadConfig(path = configPath()): DecisionConfig | null {
	let text: string;
	try {
		text = fs.readFileSync(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (err) {
		fail(`${path} is not valid JSON: ${(err as Error).message}`);
	}
	return parseConfig(raw);
}
