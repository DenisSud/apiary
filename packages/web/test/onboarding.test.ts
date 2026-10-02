import assert from "node:assert/strict";
import { test } from "node:test";
import { isValidNewBotName, kickoffPrompt, providerMethods, providerStatus, sortProviders } from "../src/onboarding-core.ts";
import type { AuthProviderInfo } from "../src/auth.ts";

// The onboarding's pure core: the name rule, the kickoff message and the
// provider lines. The view itself is exercised in the browser.

test("isValidNewBotName mirrors the pi-manager create rule", () => {
	assert.equal(isValidNewBotName("atlas"), true);
	assert.equal(isValidNewBotName("a1"), true);
	assert.equal(isValidNewBotName("my-bot-2"), true);
	assert.equal(isValidNewBotName(""), false);
	assert.equal(isValidNewBotName("Atlas"), false);
	assert.equal(isValidNewBotName("my bot"), false);
	assert.equal(isValidNewBotName("my_bot"), false);
	assert.equal(isValidNewBotName("-atlas"), false);
	assert.equal(isValidNewBotName("atlas."), false);
});

test("kickoffPrompt sends the setup prompt through the self-config skill", () => {
	assert.equal(
		kickoffPrompt(),
		"/skill:self-config Set me up — start the interview now: first question, one at a time, each with your recommendation.",
	);
});

test("sortProviders puts configured first, then sorts by name", () => {
	const provider = (name: string, configured: boolean): AuthProviderInfo => ({
		id: name.toLowerCase(),
		name,
		oauth: true,
		apiKey: true,
		configured,
	});
	const sorted = sortProviders([provider("Zed", false), provider("Beta", true), provider("Alpha", false)]);
	assert.deepEqual(
		sorted.map((entry) => entry.name),
		["Beta", "Alpha", "Zed"],
	);
});

test("providerMethods lists the offered login methods, OAuth first", () => {
	assert.deepEqual(providerMethods({ oauth: true, apiKey: true }), ["oauth", "api_key"]);
	assert.deepEqual(providerMethods({ oauth: true, apiKey: false }), ["oauth"]);
	assert.deepEqual(providerMethods({ oauth: false, apiKey: true }), ["api_key"]);
	assert.deepEqual(providerMethods({ oauth: false, apiKey: false }), []);
});

test("providerStatus names the source when there is one", () => {
	const base: AuthProviderInfo = { id: "anthropic", name: "Anthropic", oauth: true, apiKey: true, configured: false };
	assert.equal(providerStatus(base), "not connected");
	assert.equal(providerStatus({ ...base, configured: true, source: "OAuth", type: "oauth" }), "connected · OAuth");
	assert.equal(providerStatus({ ...base, configured: true, source: "ANTHROPIC_API_KEY" }), "connected · ANTHROPIC_API_KEY");
	assert.equal(providerStatus({ ...base, configured: true, type: "api_key" }), "connected");
});
