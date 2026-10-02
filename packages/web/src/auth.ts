import { bridgeUrl } from "./session.ts";

// The provider-login client: the REST side (list, start) plus the frame
// protocol over one WebSocket per login. The frames mirror `packages/auth`:
// `prompt` waits for `{type:"input", id, value}`, `notify` carries progress,
// `done`/`error` end the flow, and closing the socket aborts it.

export interface AuthProviderInfo {
	id: string;
	name: string;
	oauth: boolean;
	apiKey: boolean;
	configured: boolean;
	/** Where the active credential comes from ("stored", "environment", …). */
	source?: string;
	/** Credential type in effect when configured. */
	type?: "api_key" | "oauth";
}

export interface AuthPromptRequest {
	id: string;
	type: "text" | "secret" | "select" | "manual_code";
	message: string;
	placeholder?: string;
	options?: { id: string; label: string; description?: string }[];
}

export interface AuthInfoLink {
	url: string;
	label?: string;
}

export type AuthEvent =
	| { type: "info"; message: string; links?: AuthInfoLink[] }
	| { type: "auth_url"; url: string; instructions?: string }
	| {
			type: "device_code";
			userCode: string;
			verificationUri: string;
			intervalSeconds?: number;
			expiresInSeconds?: number;
	  }
	| { type: "progress"; message: string };

export type AuthFrame =
	| { type: "prompt"; prompt: AuthPromptRequest }
	| { type: "notify"; event: AuthEvent }
	| { type: "done" }
	| { type: "error"; message: string };

export interface AuthLoginSocket {
	/** Answer the current prompt; `select` passes the option id. */
	input(id: string, value: string): void;
	abort(): void;
}

export async function listProviders(): Promise<AuthProviderInfo[]> {
	const response = await fetch("/api/auth/providers");
	if (!response.ok) throw new Error(`/api/auth/providers: ${response.status}`);
	return ((await response.json()) as { providers: AuthProviderInfo[] }).providers;
}

/** Start a login flow; the frames begin once the socket attaches. */
export async function startLogin(provider: string, type: "api_key" | "oauth"): Promise<string> {
	const response = await fetch("/api/auth/login", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ provider, type }),
	});
	if (!response.ok) throw new Error(`/api/auth/login: ${response.status}`);
	return ((await response.json()) as { loginId: string }).loginId;
}

export function openLogin(
	loginId: string,
	onFrame: (frame: AuthFrame) => void,
	onClose: () => void,
): AuthLoginSocket {
	const ws = new WebSocket(bridgeUrl(`/api/auth/login/${encodeURIComponent(loginId)}`));
	ws.onmessage = (event) => {
		if (typeof event.data !== "string") return;
		try {
			onFrame(JSON.parse(event.data) as AuthFrame);
		} catch {
			// an unparseable frame is a protocol bug; ignore it rather than crash
		}
	};
	ws.onclose = () => onClose();
	ws.onerror = () => onClose();
	return {
		input(id: string, value: string): void {
			if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "input", id, value }));
		},
		abort(): void {
			if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "abort" }));
			ws.close();
		},
	};
}
