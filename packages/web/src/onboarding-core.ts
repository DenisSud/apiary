import type { AuthProviderInfo } from "./auth.ts";

// The onboarding's pure logic: the name rule, the kickoff message, the
// provider order and status lines. No DOM here; the view is onboarding.ts.

/** Mirrors CREATE_NAME in pi-manager's paths.ts — new names only. */
const CREATE_NAME = /^[a-z0-9][a-z0-9-]*$/;

export function isValidNewBotName(name: string): boolean {
	return CREATE_NAME.test(name);
}

/**
 * The first message a new bot gets. The `/skill:` command makes the service
 * expand the self-config skill; the rest is the service's first-setup prompt,
 * written to open the interview directly.
 */
export function kickoffPrompt(): string {
	return "/skill:self-config Set me up — start the interview now: first question, one at a time, each with your recommendation.";
}

/** Configured providers first, then by name. */
export function sortProviders(providers: readonly AuthProviderInfo[]): AuthProviderInfo[] {
	return [...providers].sort(
		(a, b) => Number(b.configured) - Number(a.configured) || a.name.localeCompare(b.name),
	);
}

/** The login methods a provider offers, OAuth first. */
export function providerMethods(provider: { oauth: boolean; apiKey: boolean }): ("oauth" | "api_key")[] {
	const methods: ("oauth" | "api_key")[] = [];
	if (provider.oauth) methods.push("oauth");
	if (provider.apiKey) methods.push("api_key");
	return methods;
}

/** The one-line status of a provider row. */
export function providerStatus(provider: AuthProviderInfo): string {
	if (!provider.configured) return "not connected";
	if (provider.source !== undefined && provider.source !== "") return `connected · ${provider.source}`;
	return provider.type === "oauth" ? "connected · OAuth" : "connected";
}
