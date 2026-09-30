// The composer pill: one line grows with the text; past 14 lines it caps
// (scrollable, fading top) until the toggle calls for the expanded 27. All the
// height math lives here; callers only say "relayout", "clear" and whether a
// session is attached.

export interface Composer {
	relayout(): void;
	value(): string;
	setValue(text: string): void;
	/** Clear after a send, restoring the button state. */
	clear(): void;
	/** Attach/detach from a session: disables the pill, sets the placeholder. */
	setEnabled(enabled: boolean, placeholder: string): void;
	focus(): void;
}

export function createComposer(
	elements: {
		form: HTMLFormElement;
		box: HTMLElement;
		input: HTMLTextAreaElement;
		toggle: HTMLButtonElement;
		send: HTMLButtonElement;
	},
	onSubmit: (text: string) => void,
): Composer {
	const { form, box, input, toggle, send } = elements;
	const promptLine = 23; // px, mirrors --prompt-line in style.css
	let expanded = false;
	let enabled = false;

	const sync = (): void => {
		send.disabled = !enabled || input.value.trim() === "";
	};

	// The transcript floats its last message clear of the pill, so the pill's
	// footprint is published for it (--composer-space, see #transcript).
	const publishSpace = (): void => {
		const below = Number.parseFloat(getComputedStyle(form).paddingBottom) || 0;
		document.documentElement.style.setProperty("--composer-space", `${box.offsetHeight + below}px`);
	};

	const relayout = (): void => {
		input.style.height = "0px";
		const natural = input.scrollHeight;
		const multiline = expanded || input.value.includes("\n") || natural > promptLine + 4;
		box.classList.toggle("multiline", multiline);
		const cap = Math.max(
			3 * promptLine,
			Math.min((expanded ? 27 : 14) * promptLine, window.innerHeight - 152),
		);
		input.style.height = `${Math.min(natural, multiline ? cap : promptLine)}px`;
		box.classList.toggle("capped", input.scrollHeight > input.clientHeight + 1);
		input.scrollTop = input.scrollHeight;
		publishSpace();
	};

	window.addEventListener("resize", relayout);

	toggle.addEventListener("click", () => {
		expanded = !expanded;
		box.classList.toggle("expanded", expanded);
		toggle.title = expanded ? "collapse input" : "expand input";
		toggle.ariaLabel = toggle.title;
		relayout();
		input.focus();
	});

	input.addEventListener("input", () => {
		relayout();
		sync();
	});

	input.addEventListener("keydown", (event) => {
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			form.requestSubmit();
		}
	});

	form.addEventListener("submit", (event) => {
		event.preventDefault();
		const text = input.value.trim();
		if (text === "" || !enabled) return;
		input.value = "";
		relayout();
		sync();
		onSubmit(text);
	});

	return {
		relayout,
		value: () => input.value,
		setValue(text: string): void {
			input.value = text;
			relayout();
			sync();
		},
		clear(): void {
			input.value = "";
			relayout();
			sync();
		},
		setEnabled(next: boolean, placeholder: string): void {
			enabled = next;
			input.disabled = !next;
			input.placeholder = placeholder;
			sync();
		},
		focus: () => input.focus(),
	};
}
