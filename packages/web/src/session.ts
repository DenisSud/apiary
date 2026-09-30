import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type ByteTransportHandlers, Client } from "@earendil-works/pi-client";
import {
	activateBuiltinClientServices,
	type ActivatedClientRuntimeServer,
} from "@pi/fork/experimental/services/activation.ts";
import { createServerServiceSource, createSessionServiceSource } from "@pi/fork/experimental/services/connection.ts";
import type { BotSummary, Operation, TranscriptSnapshot } from "./types.ts";

// One session over the connector bridge: one WebSocket carries the session's
// byte stream to the bot's pi server, and everything above it uses the same
// client stack as the TUI (Client + Chord service facades). Callers get
// snapshots, an operation, and the four lane actions — nothing else.

/** What the lane answers to a prompt/steer/compact request. */
export interface Ack {
	accepted: boolean;
	error: { message: string } | null;
}

export interface Session {
	readonly bot: string;
	readonly sessionId: string;
	snapshot(): TranscriptSnapshot | undefined;
	/** The running operation, absent while the lane is idle. */
	operation(): Operation | undefined;
	prompt(text: string): Promise<Ack>;
	steer(text: string): Promise<Ack>;
	abort(operationId: string): Promise<void>;
	compact(): Promise<Ack>;
	close(): Promise<void>;
}

export async function listBots(): Promise<BotSummary[]> {
	const response = await fetch("/api/bots");
	if (!response.ok) throw new Error(`/api/bots: ${response.status}`);
	return ((await response.json()) as { bots: BotSummary[] }).bots;
}

export async function openSession(
	bot: string,
	sessionId: string,
	onSnapshot: (snapshot: TranscriptSnapshot | undefined) => void,
): Promise<Session> {
	const ws = new WebSocket(bridgeUrl(`/ws?bot=${encodeURIComponent(bot)}&session=${sessionId}`));
	ws.binaryType = "arraybuffer";
	await new Promise<void>((resolve, reject) => {
		ws.onopen = () => resolve();
		ws.onerror = () => reject(new Error("bridge upgrade failed"));
	});

	// The upgrade starts the bot's server, so the route exists by now.
	const bots = await listBots();
	const serverId = bots.find((candidate) => candidate.name === bot)?.serverId;
	if (serverId === null || serverId === undefined) throw new Error(`bot ${bot} has no server route`);

	const client = await Client.connect({ serverId, transportFactory: browserTransport(ws) });
	const activated = await activateBuiltinClientServices({
		route: { transport: "unix", serverId, path: "bridge" },
		client,
		server: createServerServiceSource(client),
		session: createSessionServiceSource(client),
	});
	const known = activated.directory.state.value?.sessions.some((entry) => entry.sessionId === sessionId) ?? false;
	if (!known) await activated.management.create({ id: sessionId }, BACKGROUND_CONTEXT);
	await activated.management.attach(sessionId, BACKGROUND_CONTEXT);

	const agent = activated.agent;
	const unsubscribe = activated.transcript.state.subscribe((state) => onSnapshot(state.snapshot));
	// The attach registered this session as the bot's last one.
	return {
		bot,
		sessionId,
		snapshot: () => activated.transcript.state.value?.snapshot as TranscriptSnapshot | null | undefined ?? undefined,
		operation: () => {
			const operation = activated.transcript.state.value?.snapshot?.operation;
			return operation === null || operation === undefined ? undefined : (operation as Operation);
		},
		async prompt(text: string): Promise<Ack> {
			return (await agent.prompt({ message: text, images: null }, BACKGROUND_CONTEXT)) as Ack;
		},
		async steer(text: string): Promise<Ack> {
			return (await agent.steer({ message: text, images: null }, BACKGROUND_CONTEXT)) as Ack;
		},
		async abort(operationId: string): Promise<void> {
			await agent.requestAbort(operationId, BACKGROUND_CONTEXT);
		},
		async compact(): Promise<Ack> {
			return (await agent.compact({ customInstructions: null }, BACKGROUND_CONTEXT)) as Ack;
		},
		async close(): Promise<void> {
			unsubscribe();
			ws.close();
			try {
				await client.dispose();
			} catch {
				// the socket may already be gone
			}
		},
	};
}

function bridgeUrl(path: string): string {
	const scheme = location.protocol === "https:" ? "wss" : "ws";
	return `${scheme}://${location.host}${path}`;
}

/**
 * ByteTransport over one bridge WebSocket. Sends are fire-and-forget: the
 * browser API offers no completion signal, and pi frames are small.
 */
function browserTransport(ws: WebSocket) {
	return async (handlers: ByteTransportHandlers) => {
		ws.onmessage = (event) => handlers.onData(new Uint8Array(event.data as ArrayBuffer));
		ws.onclose = () => handlers.onClose();
		ws.onerror = () => handlers.onError(new Error("bridge websocket error"));
		return {
			async send(chunk: Uint8Array): Promise<void> {
				if (ws.readyState !== WebSocket.OPEN) throw new Error("bridge websocket is closed");
				ws.send(chunk);
			},
			close(): void {
				ws.close();
			},
		};
	};
}
