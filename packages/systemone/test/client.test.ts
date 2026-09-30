import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { DecisionClient, DecisionError, readNoul, type DecisionConfig } from "../src/index.ts";

function makeConfig(overrides: Partial<DecisionConfig> = {}): DecisionConfig {
	return {
		baseUrl: "http://127.0.0.1:1",
		model: "test-model",
		timeoutMs: 1000,
		guard: { enabled: true, tools: [], threshold: 0.5, authorizedThreshold: 0.7, onError: "open", contextMessages: 0, contextChars: 1 },
		...overrides,
	};
}

/** A real HTTP server with a movable response. */
function startServer() {
	const received: Array<{ url: string | undefined; headers: http.IncomingHttpHeaders; body: unknown }> = [];
	let respond: () => { status?: number; body?: unknown; delayMs?: number } = () => ({
		body: { answers: { danger: { type: "noul", noul: 0.8 }, authorized: { type: "noul", noul: 0.1 } } },
	});
	const server = http.createServer((req, res) => {
		let raw = "";
		req.on("data", (chunk) => (raw += chunk));
		req.on("end", () => {
			let parsed: unknown;
			try {
				parsed = JSON.parse(raw);
			} catch {
				parsed = raw;
			}
			received.push({ url: req.url, headers: req.headers, body: parsed });
			void (async () => {
				const { status = 200, body, delayMs = 0 } = respond();
				if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
				try {
					res.writeHead(status, { "content-type": "application/json" });
					res.end(JSON.stringify(body ?? {}));
				} catch {
					// client already gone
				}
			})();
		});
	});
	server.on("clientError", () => {});
	return new Promise<{
		baseUrl: string;
		received: typeof received;
		setRespond: (fn: typeof respond) => void;
		close: () => Promise<void>;
	}>((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as { port: number };
			resolve({
				baseUrl: `http://127.0.0.1:${port}`,
				received,
				setRespond: (fn) => {
					respond = fn;
				},
				close: () =>
					new Promise((done) => {
						server.close(() => done());
						server.closeAllConnections?.();
					}),
			});
		});
	});
}

test("sends one request with both questions and parses both answers", async () => {
	const server = await startServer();
	const client = new DecisionClient(makeConfig({ baseUrl: server.baseUrl }), {});
	const answers = await client.classify({ user_messages: ["hi"], tool_call: { name: "bash", args: { command: "ls" } } }, [
		{ id: "danger", instructions: "Is it dangerous?" },
		{ id: "authorized", instructions: "Did the user ask?", criteria: { true: "yes", false: "no" } },
	]);
	assert.equal(answers.danger.probability, 0.8);
	assert.equal(answers.authorized.probability, 0.1);
	assert.equal(server.received.length, 1);
	const sent = server.received[0];
	assert.equal(sent.url, "/v1/systemone");
	assert.equal((sent.body as { model: string }).model, "test-model");
	const questions = (sent.body as { questions: Record<string, { type: string; criteria?: unknown }> }).questions;
	assert.equal(questions.danger.type, "noul");
	assert.equal(questions.authorized.criteria !== undefined, true);
	await server.close();
});

test("accepts the nouls and root response shapes", async () => {
	const server = await startServer();
	const client = new DecisionClient(makeConfig({ baseUrl: server.baseUrl }), {});
	server.setRespond(() => ({ body: { nouls: { danger: { noul: 0.4 } } } }));
	assert.equal((await client.classify({}, [{ id: "danger", instructions: "x" }])).danger.probability, 0.4);
	server.setRespond(() => ({ body: { danger: 0.6 } }));
	assert.equal((await client.classify({}, [{ id: "danger", instructions: "x" }])).danger.probability, 0.6);
	await server.close();
});

test("sends a bearer key from the configured environment variable", async () => {
	const server = await startServer();
	const client = new DecisionClient(makeConfig({ baseUrl: server.baseUrl, apiKeyEnv: "KEV_KEY" }), { KEV_KEY: "secret" });
	await client.classify({}, [{ id: "danger", instructions: "x" }]);
	assert.equal(server.received[0].headers.authorization, "Bearer secret");
	await server.close();
});

test("sends no authorization header when the key is absent", async () => {
	const server = await startServer();
	const client = new DecisionClient(makeConfig({ baseUrl: server.baseUrl, apiKeyEnv: "KEV_KEY" }), {});
	await client.classify({}, [{ id: "danger", instructions: "x" }]);
	assert.equal(server.received[0].headers.authorization, undefined);
	await server.close();
});

test("HTTP errors become DecisionError", async () => {
	const server = await startServer();
	const client = new DecisionClient(makeConfig({ baseUrl: server.baseUrl }), {});
	server.setRespond(() => ({ status: 500, body: { error: "boom" } }));
	await assert.rejects(client.classify({}, [{ id: "danger", instructions: "x" }]), (err) => {
		assert.ok(err instanceof DecisionError);
		assert.match(err.message, /HTTP 500/);
		return true;
	});
	await server.close();
});

test("a missing answer is an error that names the question", async () => {
	const server = await startServer();
	const client = new DecisionClient(makeConfig({ baseUrl: server.baseUrl }), {});
	server.setRespond(() => ({ body: { answers: { danger: { noul: 0.5 } } } }));
	await assert.rejects(client.classify({}, [{ id: "danger", instructions: "x" }, { id: "authorized", instructions: "y" }]), /authorized/);
	await server.close();
});

test("a timeout is reported with the configured budget", async () => {
	const server = await startServer();
	const client = new DecisionClient(makeConfig({ baseUrl: server.baseUrl, timeoutMs: 50 }), {});
	server.setRespond(() => ({ delayMs: 300, body: {} }));
	await assert.rejects(client.classify({}, [{ id: "danger", instructions: "x" }]), /timed out after 50ms/);
	await server.close();
});

test("readNoul parses the known response shapes", () => {
	assert.equal(readNoul({ answers: { danger: { type: "noul", noul: 0.7 } } }, "danger"), 0.7);
	assert.equal(readNoul({ nouls: { danger: { noul: 0.2 } } }, "danger"), 0.2);
	assert.equal(readNoul({ danger: 0.9 }, "danger"), 0.9);
	assert.equal(readNoul({ answers: { danger: { noul: 5 } } }, "danger"), null);
	assert.equal(readNoul({ answers: {} }, "danger"), null);
	assert.equal(readNoul("nope", "danger"), null);
});
