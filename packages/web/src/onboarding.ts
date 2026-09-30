import {
	type AuthEvent,
	type AuthFrame,
	type AuthLoginSocket,
	type AuthPromptRequest,
	type AuthProviderInfo,
	listProviders,
	openLogin,
	startLogin,
} from "./auth.ts";
import { blobatarSvg } from "./blob.ts";
import { isValidNewBotName, providerMethods, providerStatus, sortProviders } from "./onboarding-core.ts";

// The onboarding view: connect a provider, name the bot, create it. It takes
// over the main area on first run and is reopened from the "new bot" actions.
// One screen, two steps; each step collapses to a line once it is done.

export interface OnboardingInput {
	name: string;
	task: string;
}

export interface OnboardingCallbacks {
	/** Create the bot; reject to keep the form and show the error. */
	onCreate(input: OnboardingInput): Promise<void>;
	/** Leave the flow (create mode only). */
	onCancel(): void;
}

export interface Onboarding {
	show(mode: "first-run" | "create"): void;
	hide(): void;
	visible(): boolean;
}

interface LoginPanel {
	element: HTMLElement;
	lines: HTMLElement;
	prompt: HTMLElement;
	error: HTMLElement;
	cancel: HTMLButtonElement;
	progress?: HTMLElement;
}

interface LoginState {
	provider: AuthProviderInfo;
	socket: AuthLoginSocket;
	finished: boolean;
	panel: LoginPanel;
}

function el(tag: string, className: string, text?: string): HTMLElement {
	const element = document.createElement(tag);
	element.className = className;
	if (text !== undefined) element.textContent = text;
	return element;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function anchor(url: string, label: string): HTMLAnchorElement {
	const link = document.createElement("a");
	link.href = url;
	link.target = "_blank";
	link.rel = "noopener";
	link.textContent = label;
	return link;
}

export function createOnboarding(root: HTMLElement, callbacks: OnboardingCallbacks): Onboarding {
	let mode: "first-run" | "create" = "first-run";
	let visible = false;
	let providers: AuthProviderInfo[] | undefined;
	let providerError: string | undefined;
	let providerSummary: string | undefined;
	let providerOpen = true;
	let login: LoginState | undefined;
	let creating = false;
	let focusedName = false;
	let stopBlob: (() => void) | undefined;

	/* ---------- head ---------- */

	const heading = el("h2", "", "Set up your first bot");
	const lede = el("p", "onboard-lede");
	const head = el("header", "onboard-head");
	head.append(heading, lede);

	/* ---------- provider step ---------- */

	const providerNo = el("span", "step-no", "1");
	const providerTitle = el("span", "step-title", "Connect a provider");
	const providerBadge = el("span", "step-badge");
	const providerChange = el("button", "step-change", "change");
	providerChange.type = "button";
	const providerHead = el("div", "step-head");
	providerHead.append(providerNo, providerTitle, providerBadge, providerChange);

	const providerLede = el(
		"p",
		"step-lede",
		"The bot runs on your provider account. Connect one now, or skip and add it later.",
	);
	const filter = document.createElement("input");
	filter.id = "provider-filter";
	filter.type = "search";
	filter.className = "provider-filter";
	filter.placeholder = "filter providers";
	filter.autocomplete = "off";
	const providerList = el("ul", "provider-list");
	const loginSlot = el("div", "login-slot");
	const skipButton = el("button", "ghost small skip", "Skip for now");
	skipButton.type = "button";
	const providerBody = el("div", "step-body");
	providerBody.append(providerLede, filter, providerList, loginSlot, skipButton);

	const providerDone = el("p", "step-done");
	const providerStep = el("li", "step");
	providerStep.append(providerHead, providerBody, providerDone);

	/* ---------- bot step ---------- */

	const botNo = el("span", "step-no", "2");
	const botTitle = el("span", "step-title", "Create the bot");
	const botHead = el("div", "step-head");
	botHead.append(botNo, botTitle);

	const nameLabel = el("span", "field-label", "Name");
	const blobSlot = el("span", "blob-slot");
	const nameInput = document.createElement("input");
	nameInput.id = "bot-name";
	nameInput.className = "name-input";
	nameInput.type = "text";
	nameInput.placeholder = "e.g. atlas";
	nameInput.autocomplete = "off";
	nameInput.spellcheck = false;
	const nameRow = el("div", "name-row");
	nameRow.append(blobSlot, nameInput);
	const nameHint = el("span", "field-hint", "lowercase letters, digits and dashes");
	const nameField = el("label", "field");
	nameField.append(nameLabel, nameRow, nameHint);

	const taskLabel = el("span", "field-label");
	taskLabel.append("What will this bot work on? ", el("span", "field-optional", "optional"));
	const taskInput = document.createElement("textarea");
	taskInput.id = "bot-task";
	taskInput.className = "task-input";
	taskInput.rows = 3;
	taskInput.placeholder = "e.g. homelab upkeep and note keeping";
	const taskField = el("label", "field");
	taskField.append(taskLabel, taskInput);

	const formError = el("p", "form-error");
	formError.hidden = true;

	const createButton = el("button", "primary create", "Create bot");
	createButton.type = "button";
	createButton.disabled = true;
	const cancelButton = el("button", "ghost cancel", "Cancel");
	cancelButton.type = "button";
	const actions = el("div", "step-actions");
	actions.append(createButton, cancelButton);

	const botBody = el("div", "step-body");
	botBody.append(nameField, taskField, formError, actions);
	const botStep = el("li", "step");
	botStep.hidden = true;
	botStep.append(botHead, botBody);

	const steps = el("ol", "steps");
	steps.append(providerStep, botStep);
	const wrap = el("div", "onboard-wrap");
	wrap.append(head, steps);
	root.append(wrap);

	/* ---------- step state ---------- */

	function applyHead(): void {
		if (mode === "first-run") {
			heading.textContent = "Set up your first bot";
			lede.textContent =
				"Connect a provider, then create a bot. Its first chat sets it up — identity, behavior and skills.";
		} else {
			heading.textContent = "New bot";
			lede.textContent = "Give it a name. Its first chat sets it up — identity, behavior and skills.";
		}
		cancelButton.hidden = mode === "first-run";
	}

	function updateSkip(): void {
		skipButton.hidden = !providerOpen || (login !== undefined && !login.finished);
	}

	function applyProviderState(): void {
		const done = providerSummary !== undefined && !providerOpen;
		providerBody.hidden = done;
		providerDone.hidden = !done;
		providerDone.textContent = providerSummary ?? "";
		providerChange.hidden = !done;
		providerBadge.textContent = done ? "done" : "";
		providerBadge.className = done ? "step-badge done" : "step-badge";
		botStep.hidden = providerSummary === undefined;
		if (!botStep.hidden && !focusedName) {
			focusedName = true;
			nameInput.focus();
		}
		updateSkip();
	}

	function setProviderDone(summary: string): void {
		providerSummary = summary;
		providerOpen = false;
		applyProviderState();
	}

	/* ---------- provider list ---------- */

	function renderProviders(): void {
		providerList.replaceChildren();
		if (providers === undefined) {
			const note = el("li", "provider-note");
			if (providerError !== undefined) {
				note.append(providerError, " ");
				const retry = el("button", "linkish", "retry");
				retry.type = "button";
				retry.addEventListener("click", () => void loadProviders());
				note.append(retry);
			} else {
				note.textContent = "checking providers…";
			}
			providerList.append(note);
			return;
		}
		const needle = filter.value.trim().toLowerCase();
		const shown = providers.filter((provider) => needle === "" || provider.name.toLowerCase().includes(needle));
		if (shown.length === 0) {
			providerList.append(el("li", "provider-note", "no provider matches"));
			return;
		}
		for (const provider of shown) {
			const item = el("li", "provider");
			if (provider.configured) item.classList.add("configured");
			const name = el("span", "provider-name", provider.name);
			const state = el("span", "provider-state", providerStatus(provider));
			const providerActions = el("span", "provider-actions");
			for (const method of providerMethods(provider)) {
				const button = el("button", "ghost small", method === "oauth" ? "Sign in" : "Use API key");
				button.type = "button";
				button.addEventListener("click", () => void beginLogin(provider, method));
				providerActions.append(button);
			}
			item.append(name, state, providerActions);
			providerList.append(item);
		}
	}

	async function loadProviders(): Promise<void> {
		providerError = undefined;
		try {
			providers = sortProviders(await listProviders());
		} catch (error) {
			providers = undefined;
			providerError = message(error);
		}
		renderProviders();
		if (providerSummary === undefined && providers !== undefined && providers.some((p) => p.configured)) {
			const names = providers
				.filter((p) => p.configured)
				.map((p) => p.name)
				.join(", ");
			setProviderDone(`Using ${names}.`);
		}
	}

	/* ---------- login flow ---------- */

	function stopLogin(): void {
		const current = login;
		login = undefined;
		if (current !== undefined && !current.finished) current.socket.abort();
	}

	function buildLoginPanel(provider: AuthProviderInfo, method: "oauth" | "api_key"): LoginPanel {
		const panelHead = el(
			"p",
			"login-head",
			method === "oauth" ? `Signing in to ${provider.name}…` : `Connecting ${provider.name}…`,
		);
		const lines = el("div", "login-lines");
		const prompt = el("div", "login-prompt");
		const error = el("p", "login-error");
		error.hidden = true;
		const cancel = el("button", "ghost small", "cancel");
		cancel.type = "button";
		cancel.addEventListener("click", () => {
			const current = login;
			if (current === undefined || current.finished) return;
			current.finished = true;
			current.panel.prompt.replaceChildren();
			current.panel.error.textContent = "login cancelled";
			current.panel.error.hidden = false;
			current.panel.cancel.hidden = true;
			current.socket.abort();
			updateSkip();
		});
		const element = el("div", "login");
		element.append(panelHead, lines, prompt, error, cancel);
		return { element, lines, prompt, error, cancel };
	}

	async function beginLogin(provider: AuthProviderInfo, method: "oauth" | "api_key"): Promise<void> {
		stopLogin();
		loginSlot.replaceChildren(el("p", "provider-note", "starting…"));
		try {
			const loginId = await startLogin(provider.id, method);
			const panel = buildLoginPanel(provider, method);
			loginSlot.replaceChildren(panel.element);
			const socket = openLogin(loginId, handleFrame, () => onLoginClosed());
			login = { provider, socket, finished: false, panel };
			updateSkip();
		} catch (error) {
			loginSlot.replaceChildren(el("p", "login-error", message(error)));
		}
	}

	function onLoginClosed(): void {
		const current = login;
		if (current === undefined || current.finished) return;
		current.finished = true;
		current.panel.prompt.replaceChildren();
		current.panel.error.textContent = "login interrupted";
		current.panel.error.hidden = false;
		current.panel.cancel.hidden = true;
		updateSkip();
	}

	function handleFrame(frame: AuthFrame): void {
		const current = login;
		if (current === undefined || current.finished) return;
		const panel = current.panel;
		switch (frame.type) {
			case "prompt":
				renderPrompt(current, frame.prompt);
				return;
			case "notify":
				renderEvent(panel, frame.event);
				return;
			case "error":
				current.finished = true;
				panel.prompt.replaceChildren();
				panel.error.textContent = frame.message;
				panel.error.hidden = false;
				panel.cancel.hidden = true;
				updateSkip();
				return;
			case "done": {
				current.finished = true;
				panel.element.remove();
				login = undefined;
				updateSkip();
				const name = current.provider.name;
				void loadProviders().then(() => {
					if (visible) setProviderDone(`Connected to ${name}.`);
				});
				return;
			}
		}
	}

	function renderEvent(panel: LoginPanel, event: AuthEvent): void {
		switch (event.type) {
			case "progress": {
				if (panel.progress === undefined) {
					panel.progress = el("p", "login-line login-progress");
					panel.lines.append(panel.progress);
				}
				panel.progress.textContent = event.message;
				return;
			}
			case "info": {
				const line = el("p", "login-line", event.message);
				for (const link of event.links ?? []) line.append(" ", anchor(link.url, link.label ?? link.url));
				panel.lines.append(line);
				return;
			}
			case "auth_url": {
				const block = el("div", "login-block");
				block.append(anchor(event.url, "Open the sign-in page"));
				if (event.instructions !== undefined) block.append(el("p", "login-line", event.instructions));
				panel.lines.append(block);
				return;
			}
			case "device_code": {
				const block = el("div", "login-block");
				block.append(el("p", "login-line", "Enter this code on the verification page:"));
				const code = el("code", "login-code", event.userCode);
				const copy = el("button", "ghost small", "copy");
				copy.type = "button";
				copy.addEventListener("click", () => void copyText(event.userCode, copy));
				const row = el("div", "login-coderow");
				row.append(code, copy);
				block.append(row, anchor(event.verificationUri, event.verificationUri));
				panel.lines.append(block);
				return;
			}
		}
	}

	function renderPrompt(current: LoginState, prompt: AuthPromptRequest): void {
		const slot = current.panel.prompt;
		slot.replaceChildren(el("p", "login-line", prompt.message));
		if (prompt.type === "select" && prompt.options !== undefined) {
			const options = el("div", "login-options");
			for (const option of prompt.options) {
				const button = el("button", "option");
				button.type = "button";
				button.append(el("span", "option-label", option.label));
				if (option.description !== undefined) button.append(el("span", "option-desc", option.description));
				button.addEventListener("click", () => answer(current, prompt.id, option.id));
				options.append(button);
			}
			slot.append(options);
			return;
		}
		const input = document.createElement("input");
		input.id = "login-input";
		input.type = prompt.type === "secret" ? "password" : "text";
		input.placeholder = prompt.placeholder ?? "";
		input.autocomplete = "off";
		input.spellcheck = false;
		const submit = el("button", "primary small", "continue");
		submit.type = "button";
		const send = (): void => {
			if (input.value === "") return;
			answer(current, prompt.id, input.value);
		};
		submit.addEventListener("click", send);
		input.addEventListener("keydown", (event) => {
			if (event.key === "Enter") {
				event.preventDefault();
				send();
			}
		});
		const row = el("div", "login-input");
		row.append(input, submit);
		slot.append(row);
		input.focus();
	}

	function answer(current: LoginState, id: string, value: string): void {
		if (current.finished) return;
		for (const control of current.panel.prompt.querySelectorAll<HTMLInputElement | HTMLButtonElement>(
			"input, button",
		)) {
			control.disabled = true;
		}
		current.socket.input(id, value);
	}

	async function copyText(text: string, button: HTMLButtonElement): Promise<void> {
		try {
			await navigator.clipboard.writeText(text);
			button.textContent = "copied";
			window.setTimeout(() => {
				button.textContent = "copy";
			}, 1500);
		} catch {
			// no clipboard (insecure context); the code stays visible to select
		}
	}

	/* ---------- bot step ---------- */

	function updateName(): void {
		const name = nameInput.value.trim();
		const valid = isValidNewBotName(name);
		nameHint.textContent =
			valid || name === "" ? "lowercase letters, digits and dashes" : "use lowercase letters, digits and dashes";
		nameHint.classList.toggle("bad", !valid && name !== "");
		stopBlob?.();
		stopBlob = undefined;
		blobSlot.replaceChildren();
		if (valid) {
			const blob = blobatarSvg(name, "avatar onboard-avatar", true);
			stopBlob = blob.stop;
			blobSlot.append(blob.element);
		}
		updateCreate();
	}

	function updateCreate(): void {
		createButton.disabled = creating || !isValidNewBotName(nameInput.value.trim());
		createButton.textContent = creating ? "Creating…" : "Create bot";
	}

	async function submit(): Promise<void> {
		const name = nameInput.value.trim();
		if (creating || !isValidNewBotName(name)) return;
		creating = true;
		formError.hidden = true;
		nameInput.disabled = true;
		taskInput.disabled = true;
		updateCreate();
		try {
			await callbacks.onCreate({ name, task: taskInput.value });
		} catch (error) {
			formError.textContent = message(error);
			formError.hidden = false;
		} finally {
			creating = false;
			nameInput.disabled = false;
			taskInput.disabled = false;
			updateCreate();
		}
	}

	/* ---------- wiring ---------- */

	filter.addEventListener("input", () => renderProviders());
	skipButton.addEventListener("click", () => setProviderDone("Skipped — connect a provider when you need it."));
	providerChange.addEventListener("click", () => {
		providerOpen = true;
		applyProviderState();
	});
	createButton.addEventListener("click", () => void submit());
	cancelButton.addEventListener("click", () => callbacks.onCancel());
	nameInput.addEventListener("input", () => updateName());

	/* ---------- public ---------- */

	function show(nextMode: "first-run" | "create"): void {
		mode = nextMode;
		visible = true;
		focusedName = false;
		stopLogin();
		loginSlot.replaceChildren();
		providerSummary = undefined;
		providerOpen = true;
		providerError = undefined;
		providers = undefined;
		filter.value = "";
		nameInput.value = "";
		taskInput.value = "";
		formError.hidden = true;
		stopBlob?.();
		stopBlob = undefined;
		blobSlot.replaceChildren();
		applyHead();
		applyProviderState();
		updateName();
		renderProviders();
		void loadProviders();
	}

	function hide(): void {
		visible = false;
		stopLogin();
		loginSlot.replaceChildren();
		stopBlob?.();
		stopBlob = undefined;
		blobSlot.replaceChildren();
	}

	return { show, hide, visible: () => visible };
}
