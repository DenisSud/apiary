import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/index.ts";

const dir = mkdtempSync(join(tmpdir(), "decision-config-"));
let seq = 0;

function write(config: unknown): string {
	const file = join(dir, `config-${seq++}.json`);
	writeFileSync(file, typeof config === "string" ? config : JSON.stringify(config));
	return file;
}

test("missing config file returns null", () => {
	assert.equal(loadConfig(join(dir, "missing.json")), null);
});

test("empty config applies every default", () => {
	const config = loadConfig(write({}));
	assert.ok(config);
	assert.equal(config.baseUrl, "http://127.0.0.1:8009");
	assert.equal(config.model, "kev-latest");
	assert.equal(config.timeoutMs, 2000);
	assert.equal(config.apiKeyEnv, undefined);
	assert.deepEqual(config.guard, {
		enabled: true,
		tools: ["bash"],
		threshold: 0.5,
		authorizedThreshold: 0.7,
		onError: "open",
		contextMessages: 4,
		contextChars: 1500,
	});
});

test("explicit values are respected and baseUrl is normalized", () => {
	const config = loadConfig(
		write({
			baseUrl: "http://127.0.0.1:9000/v1/",
			model: "kev-4b",
			timeoutMs: 500,
			apiKeyEnv: "KEV_KEY",
			guard: {
				enabled: false,
				tools: ["mytool"],
				threshold: 0.2,
				authorizedThreshold: 0.9,
				onError: "closed",
				contextMessages: 1,
				contextChars: 100,
				blockedMessage: "nope {tool_name}",
			},
		}),
	);
	assert.ok(config);
	assert.equal(config.baseUrl, "http://127.0.0.1:9000/v1");
	assert.equal(config.model, "kev-4b");
	assert.equal(config.timeoutMs, 500);
	assert.equal(config.apiKeyEnv, "KEV_KEY");
	assert.deepEqual(config.guard, {
		enabled: false,
		tools: ["mytool"],
		threshold: 0.2,
		authorizedThreshold: 0.9,
		onError: "closed",
		contextMessages: 1,
		contextChars: 100,
		blockedMessage: "nope {tool_name}",
	});
});

test("a trailing slash on the root baseUrl disappears", () => {
	const config = loadConfig(write({ baseUrl: "http://127.0.0.1:8009/" }));
	assert.equal(config?.baseUrl, "http://127.0.0.1:8009");
});

test("invalid configs fail loudly", () => {
	const cases: Array<[unknown, RegExp]> = [
		[[], /root must be an object/],
		[{ baseUrl: "not a url" }, /not a valid URL/],
		[{ baseUrl: "ftp://x" }, /http\(s\)/],
		[{ model: "" }, /model/],
		[{ timeoutMs: 0 }, /timeoutMs/],
		[{ apiKeyEnv: "1BAD" }, /apiKeyEnv/],
		[{ guard: { enabled: "yes" } }, /enabled/],
		[{ guard: { tools: [] } }, /tools/],
		[{ guard: { tools: ["ok", ""] } }, /tools entries/],
		[{ guard: { threshold: 2 } }, /threshold/],
		[{ guard: { authorizedThreshold: -0.1 } }, /authorizedThreshold/],
		[{ guard: { onError: "sometimes" } }, /onError/],
		[{ guard: { contextMessages: -1 } }, /contextMessages/],
		[{ guard: { contextChars: 0 } }, /contextChars/],
		[{ guard: { blockedMessage: "" } }, /blockedMessage/],
	];
	for (const [raw, pattern] of cases) {
		assert.throws(() => loadConfig(write(raw)), pattern, `expected ${pattern} for ${JSON.stringify(raw)}`);
	}
});

test("invalid JSON fails with the path in the message", () => {
	const file = write("{ nope");
	assert.throws(() => loadConfig(file), new RegExp(`not valid JSON`));
});
