/**
 * The ptc registration contract, mirrored in `registry/ptc/registry.ts`.
 *
 * Extensions opt tools into programmatic calling by registering them here;
 * the `ptc` extension (a registry package) reads the same store and exposes
 * each registration to generated programs as a global async function. The
 * store lives on `globalThis` under a shared symbol, so every module instance
 * — and the registry's own copy of this contract — sees one map.
 *
 * The base and the registry never import each other (the registry may be
 * mounted at any path), so both copies exist on purpose. Keep them in sync:
 * the symbol key and the registration shape are the contract.
 */

export type PtcArgs = Record<string, unknown>;
export type PtcRun = (args: PtcArgs, ctx: unknown) => unknown | Promise<unknown>;

export interface PtcRegistration {
	name: string;
	run: PtcRun;
	/** One-line binding contract, e.g. "{ query, max_results? } → { query, results: [...] }". */
	signature?: string;
}

const REGISTRY_KEY = Symbol.for("pi-setup.ptc.registry");
type RegistryHost = typeof globalThis & { [REGISTRY_KEY]?: Map<string, PtcRegistration> };

export function registerPtcTool(name: string, run: PtcRun, opts?: { signature?: string }): void {
	const host = globalThis as RegistryHost;
	const registry: Map<string, PtcRegistration> = (host[REGISTRY_KEY] ??= new Map());
	registry.set(name, { name, run, signature: opts?.signature });
}
