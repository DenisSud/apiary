import { blobatarSvg } from "./blob.ts";
import { createBotList } from "./bots.ts";
import { createComposer } from "./composer.ts";
import { createOnboarding } from "./onboarding.ts";
import { kickoffPrompt } from "./onboarding-core.ts";
import { createPanel } from "./panel.ts";
import { createFollower } from "./scroll.ts";
import { type Session, createBot, listBots, openSession, reloadBot } from "./session.ts";
import { createTranscript } from "./transcript.ts";
import { type BotSummary, type TranscriptSnapshot, queuedMessages, textOf } from "./types.ts";

// The composition root: DOM handles, app state (the open session, the bot
// list, the busy flag) and the wiring between the modules. Everything below
// this file knows nothing about the others.

const botList = mustFind<HTMLUListElement>("#bot-list");
const refreshButton = mustFind<HTMLButtonElement>("#refresh");
const sessionTitle = mustFind<HTMLSpanElement>("#session-title");
const sessionStatus = mustFind<HTMLSpanElement>("#session-status");
const transcriptElement = mustFind<HTMLElement>("#transcript");
const promptForm = mustFind<HTMLFormElement>("#prompt-form");
const promptInput = mustFind<HTMLTextAreaElement>("#prompt");
const composerElement = mustFind<HTMLElement>("#composer");
const composerToggle = mustFind<HTMLButtonElement>("#composer-toggle");
const sendButton = mustFind<HTMLButtonElement>("#send");
const stopButton = mustFind<HTMLButtonElement>("#stop");
const compactButton = mustFind<HTMLButtonElement>("#compact");
const newButton = mustFind<HTMLButtonElement>("#new");
const latestButton = mustFind<HTMLButtonElement>("#latest");
const latestSpinner = document.querySelector<HTMLElement>("#latest-spin");
const menuButton = mustFind<HTMLButtonElement>("#menu");
const sidebarCloseButton = mustFind<HTMLButtonElement>("#sidebar-close");
const scrim = mustFind<HTMLElement>("#scrim");
const newBotButton = mustFind<HTMLButtonElement>("#new-bot");
const emptyState = mustFind<HTMLElement>("#chat-empty");
const emptyNewButton = mustFind<HTMLButtonElement>("#empty-new-bot");
const setupChip = mustFind<HTMLSpanElement>("#session-setup");
const onboardingRoot = mustFind<HTMLElement>("#onboarding");

let active: Session | undefined;
let bots: BotSummary[] = [];
// True while the open session has a running turn; drives the sidebar marker
// and the jump pill's spinner.
let laneBusy = false;
// True while openSession resolves: keeps the empty state from flashing.
let connecting = false;
// A pending post-commit apply: polled while one waits, applied when idle.
let setupTimer: number | undefined;
let applying = false;
let applyFailed = false;

function mustFind<T extends Element>(selector: string): T {
	const element = document.querySelector<T>(selector);
	if (element === null) throw new Error(`missing element ${selector}`);
	return element;
}

const transcript = createTranscript(transcriptElement);
const follower = createFollower(transcriptElement, {
	onChange: () => updatePill(),
	ownsToggle: (target) => transcript.ownsToggle(target),
});
const composer = createComposer(
	{ form: promptForm, box: composerElement, input: promptInput, toggle: composerToggle, send: sendButton },
	sendPrompt,
);
const botRows = createBotList(botList, (name) => void openBot(name, false));
const panel = createPanel({ menu: menuButton, close: sidebarCloseButton, scrim });
const onboarding = createOnboarding(onboardingRoot, {
	onCreate: (input) => startBot(input.name),
	onCancel: () => hideOnboarding(),
});

/* ---------- header, status, pill ---------- */

// The session header holds the one live blobatar; its gaze driver has to be
// stopped whenever the header is rebuilt.
let liveBlobatarStop: (() => void) | undefined;

function setSessionTitle(bot?: string, sessionId?: string): void {
	liveBlobatarStop?.();
	liveBlobatarStop = undefined;
	sessionTitle.replaceChildren();
	if (bot === undefined || sessionId === undefined) {
		sessionTitle.textContent = "no session";
		return;
	}
	const blob = blobatarSvg(bot, "avatar title-blob", true);
	liveBlobatarStop = blob.stop;
	const name = document.createElement("span");
	name.className = "title-name";
	name.textContent = bot;
	sessionTitle.append(blob.element, name);
}

function setStatus(text: string, kind: "idle" | "busy" | "error" = "idle"): void {
	const dot = document.createElement("span");
	dot.className = "dot";
	sessionStatus.replaceChildren(dot, document.createTextNode(text));
	sessionStatus.className = kind;
}

function updatePill(): void {
	const show = !follower.pinned && active !== undefined;
	latestButton.classList.toggle("show", show);
}

/* ---------- app state ---------- */

async function refreshBots(): Promise<void> {
	try {
		bots = await listBots();
	} catch (error) {
		setStatus(message(error), "error");
		return;
	}
	botRows.render(bots, active?.bot, laneBusy);
	updateChrome();
	watchSetup();
	void maybeApply();
	if (bots.length === 0 && !onboarding.visible()) showOnboarding("first-run");
}

/* ---------- onboarding, empty state, setup chip ---------- */

function showOnboarding(mode: "first-run" | "create"): void {
	// the class first: the view focuses its name field, and a hidden one cannot
	document.body.classList.add("onboarding");
	onboarding.show(mode);
	updateChrome();
}

function hideOnboarding(): void {
	onboarding.hide();
	document.body.classList.remove("onboarding");
	updateChrome();
}

/** The main-area swap: the empty state, and the setup chip on the bar. */
function updateChrome(): void {
	const empty = active === undefined && !connecting && !onboarding.visible() && bots.length > 0;
	emptyState.hidden = !empty;
	document.body.classList.toggle("no-session", empty);
	updateSetupChip();
}

function updateSetupChip(): void {
	const summary = bots.find((candidate) => candidate.name === active?.bot);
	const pending = summary !== undefined && (summary.setup || summary.apply);
	setupChip.hidden = !pending;
	if (pending && summary !== undefined) setupChip.textContent = summary.setup ? "setting up" : "applying changes";
}

/** Poll while the active bot is in setup or has an apply waiting. */
function watchSetup(): void {
	const summary = bots.find((candidate) => candidate.name === active?.bot);
	const pending = summary !== undefined && (summary.setup || summary.apply);
	if (pending && setupTimer === undefined) {
		setupTimer = window.setInterval(() => void refreshBots(), 3000);
	} else if (!pending && setupTimer !== undefined) {
		window.clearInterval(setupTimer);
		setupTimer = undefined;
	}
}

/**
 * The apply watcher never touches a bot with an attached client, so once a
 * post-commit marker lands and the turn settles, reload and re-attach here.
 */
async function maybeApply(): Promise<void> {
	const session = active;
	if (session === undefined || applying) return;
	const summary = bots.find((candidate) => candidate.name === session.bot);
	if (summary === undefined || summary.setup || !summary.apply) {
		applyFailed = false;
		return;
	}
	if (applyFailed || session.operation() !== undefined) return;
	applying = true;
	try {
		await reloadBot(session.bot);
		await openBot(session.bot, false);
		await refreshBots();
	} catch (error) {
		applyFailed = true;
		setStatus(message(error), "error");
	} finally {
		applying = false;
	}
}

function updateActions(): void {
	const operation = active?.operation();
	stopButton.disabled = active === undefined || operation?.status !== "open";
	compactButton.disabled = active === undefined || operation !== undefined;
	newButton.disabled = active === undefined;
	const busy = operation !== undefined;
	if (laneBusy !== busy) {
		laneBusy = busy;
		if (latestSpinner !== null) latestSpinner.hidden = !laneBusy;
		botRows.render(bots, active?.bot, laneBusy);
	}
}

function updateComposer(): void {
	const session = active;
	const live = session !== undefined;
	composer.setEnabled(live, !live ? "Select a bot" : session.operation() !== undefined ? "Steer the agent\u2026" : `Message ${session.bot}`);
}

/** Text still in the lane queues, handed back to the composer on abort. */
function restoreQueued(): void {
	const snapshot = active?.snapshot();
	const dropped = queuedMessages(snapshot ?? ({ transcript: [], operation: null } as TranscriptSnapshot))
		.map((item) => textOf(item.message ?? { role: "user" }).trim())
		.filter((text) => text !== "");
	if (dropped.length === 0) return;
	const text = dropped.join("\n\n");
	const current = composer.value().trim();
	composer.setValue(current === "" ? text : `${text}\n\n${current}`);
}

/* ---------- sessions ---------- */

/** Create the bot, open its first session and send the setup kickoff. */
async function startBot(name: string): Promise<void> {
	await createBot(name);
	// hold the empty state back until the new session is up
	connecting = true;
	hideOnboarding();
	try {
		await refreshBots();
		await openBot(name, true);
	} finally {
		connecting = false;
	}
	sendPrompt(kickoffPrompt());
}

async function openBot(bot: string, fresh: boolean): Promise<void> {
	await closeSession();
	connecting = true;
	setStatus("connecting", "busy");
	updateChrome();
	try {
		const summary = bots.find((candidate) => candidate.name === bot);
		if (summary === undefined) throw new Error(`unknown bot ${bot}`);
		const sessionId = fresh || summary.lastSession === null ? crypto.randomUUID() : summary.lastSession.sessionId;
		const session = await openSession(bot, sessionId, (snapshot) => {
			if (active === session) renderSnapshot(snapshot);
		});
		active = session;
		setSessionTitle(bot, sessionId);
		follower.reset();
		// picking a bot from the drawer is the end of the drawer's job
		if (panel.overlay()) panel.close();
		renderSnapshot(session.snapshot());
		updateComposer();
		botRows.render(bots, active.bot, laneBusy);
		composer.focus();
		void refreshBots();
	} catch (error) {
		setStatus(message(error), "error");
	} finally {
		connecting = false;
	}
	updateChrome();
}

async function closeSession(): Promise<void> {
	const closing = active;
	if (closing === undefined) return;
	active = undefined;
	transcript.reset();
	follower.reset();
	updatePill();
	setSessionTitle();
	updateComposer();
	updateActions();
	await closing.close();
}

function renderSnapshot(snapshot: TranscriptSnapshot | undefined): void {
	if (snapshot === undefined) {
		setStatus("waiting for the transcript", "busy");
		return;
	}
	const running = snapshot.operation !== null && snapshot.operation !== undefined;
	transcript.render(snapshot);
	updatePill();
	if (sessionStatus.className !== "error") setStatus(running ? "running" : "ready", running ? "busy" : "idle");
	updateComposer();
	updateActions();
	void maybeApply();
}

/* ---------- actions ---------- */

function sendPrompt(text: string): void {
	const session = active;
	if (session === undefined) return;
	follower.jump();
	// While a turn runs the message steers it; otherwise it starts a turn.
	const call = session.operation() !== undefined ? session.steer(text) : session.prompt(text);
	void call.then(
		(ack) => {
			if (ack.accepted) return;
			composer.setValue(text);
			setStatus(ack.error?.message ?? "rejected", "error");
			updateComposer();
		},
		(error: unknown) => {
			composer.setValue(text);
			setStatus(message(error), "error");
			updateComposer();
		},
	);
}

stopButton.addEventListener("click", () => {
	const session = active;
	const operation = session?.operation();
	if (session === undefined || operation === undefined) return;
	restoreQueued();
	stopButton.disabled = true;
	setStatus("aborting", "busy");
	void session.abort(operation.id).catch((error: unknown) => {
		setStatus(message(error), "error");
		updateActions();
	});
});

compactButton.addEventListener("click", () => {
	const session = active;
	if (session === undefined) return;
	compactButton.disabled = true;
	setStatus("compacting", "busy");
	void session.compact().then(
		(ack) => {
			if (!ack.accepted || ack.error !== null) {
				setStatus(ack.error?.message ?? "compact failed", "error");
			} else if (sessionStatus.className === "error") {
				setStatus("ready", "idle");
			}
			updateActions();
		},
		(error: unknown) => {
			setStatus(message(error), "error");
			updateActions();
		},
	);
});

newButton.addEventListener("click", () => {
	const session = active;
	if (session !== undefined) void openBot(session.bot, true);
});

/* ---------- chrome ---------- */

latestButton.addEventListener("click", () => follower.jump(true));
refreshButton.addEventListener("click", () => void refreshBots());
newBotButton.addEventListener("click", () => showOnboarding("create"));
emptyNewButton.addEventListener("click", () => showOnboarding("create"));
window.addEventListener("focus", () => void refreshBots());

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// No prompt until a session is attached and hydrated.
transcript.reset();
updatePill();
updateComposer();
await refreshBots();
