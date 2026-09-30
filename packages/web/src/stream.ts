import { renderMarkdown } from "./markdown.ts";

// Streaming answer text. The settled part is re-rendered as markdown; what
// just arrived fades in as a tail, and any rewrite (not an append) re-renders
// whole with no animation.

export interface Stream {
	/** The element the answer lives in; the caller places it. */
	wrap: HTMLElement;
	update(text: string): void;
}

export function createStream(): Stream {
	const wrap = document.createElement("div");
	wrap.className = "text markdown";
	const settled = document.createElement("div");
	settled.className = "settled";
	let tail = document.createElement("span");
	tail.className = "tail";
	settled.append(tail);
	wrap.append(settled);
	let source = "";

	/** Put the tail at the end of the last block, so it flows inline. */
	const placeTail = (): void => {
		const blocks = settled.children;
		const last = blocks[blocks.length - 1];
		if (last !== undefined && /^(P|LI|H[1-4]|UL|OL|BLOCKQUOTE)$/.test(last.tagName)) last.append(tail);
		else settled.append(tail);
	};

	const reveal = (parent: HTMLElement, text: string): void => {
		const span = document.createElement("span");
		span.className = "w-fade";
		span.textContent = text;
		parent.append(span);
	};

	const update = (next: string): void => {
		const shown = source + (tail.textContent ?? "");
		if (shown !== "" && next.startsWith(shown)) {
			source = shown;
			settled.innerHTML = renderMarkdown(shown);
			const fresh = document.createElement("span");
			fresh.className = "tail";
			const delta = next.slice(shown.length);
			if (delta !== "") {
				if (delta.length <= 40) reveal(fresh, delta);
				else for (const word of delta.match(/\S+ ?/g) ?? []) reveal(fresh, word);
			}
			tail.replaceWith(fresh);
			tail = fresh;
			placeTail();
			return;
		}
		source = next;
		settled.innerHTML = renderMarkdown(next);
		tail.replaceChildren();
		placeTail();
	};

	return { wrap, update };
}
