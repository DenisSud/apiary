// Following the end of a scrollable list: state, not animation.
//
// `pinned` is the whole state — true while the reader sits at the end and
// wants new output to pull the view along, false the moment they move up even
// a pixel. Our own follow-scrolls only ever increase scrollTop, so an upward
// move the browser did not make by shrinking content is the reader's doing
// (wheel, touch, keys, scrollbar drag, selection drag); landing back at the
// end re-pins. Content changes are watched with ResizeObserver instead of
// being hooked to messages, and following writes scrollTop instantly —
// gliding toward a target that keeps moving lags, wobbles and reports its own
// scroll events back to us.

export interface Follower {
	readonly pinned: boolean;
	/** Re-pin and go to the end; smooth only for an explicit jump. */
	jump(smooth?: boolean): void;
	/** Re-check the end (content may have shrunk under an unpinned reader). */
	refresh(): void;
	reset(): void;
}

export interface ScrollSample {
	top: number;
	height: number;
}

/**
 * The pin decision after a scroll event. Content shrinking lowers scrollTop by
 * itself; any other upward move is the reader leaving the end.
 */
export function pinnedAfterScroll(
	wasPinned: boolean,
	previous: ScrollSample,
	next: ScrollSample,
	atEnd: boolean,
): boolean {
	if (next.top < previous.top - 0.5 && next.height >= previous.height - 1) return false;
	if (atEnd) return true;
	return wasPinned;
}

export function createFollower(
	list: HTMLElement,
	hooks: { onChange(pinned: boolean): void; ownsToggle?: (target: EventTarget | null) => boolean },
): Follower {
	const atEndSlack = 2;
	let pinned = true;
	let lastTop = 0;
	let lastHeight = 0;
	// True while a touch or the momentum it started is still moving the list.
	let touchOwned = false;
	let touchTimer: number | undefined;

	const atEnd = (): boolean => list.scrollHeight - list.clientHeight - list.scrollTop <= atEndSlack;

	const stickToEnd = (): void => {
		// A finger (or the momentum it started) owns the list: writing scrollTop
		// mid-fling fights iOS momentum, so wait for it to finish.
		if (touchOwned) return;
		list.scrollTop = list.scrollHeight;
	};

	const setPinned = (next: boolean): void => {
		if (next === pinned) return;
		pinned = next;
		hooks.onChange(pinned);
	};

	const followContent = (): void => {
		if (pinned) stickToEnd();
		// Content can shrink under an unpinned reader (a collapsed trace, a
		// finished swap) and land them back at the end without a scroll event.
		else if (atEnd()) setPinned(true);
	};

	/* ---------- what counts as content ---------- */

	// The boxes whose size means "the content changed": the list's children and
	// the children of any `display: contents` wrapper (the live slot has no box
	// of its own, so observing it would never fire).
	const contentBoxes = (): Element[] => {
		const boxes: Element[] = [];
		const visit = (parent: Element): void => {
			for (const child of parent.children) {
				boxes.push(child);
				if (getComputedStyle(child).display === "contents") visit(child);
			}
		};
		visit(list);
		return boxes;
	};

	const observer = new ResizeObserver(followContent);
	const watched = new Set<Element>();
	const watchContent = (): void => {
		for (const box of contentBoxes()) {
			if (watched.has(box)) continue;
			watched.add(box);
			observer.observe(box);
		}
		for (const box of [...watched]) {
			if (box.isConnected) continue;
			watched.delete(box);
			observer.unobserve(box);
		}
		followContent();
	};
	new MutationObserver(watchContent).observe(list, { childList: true, subtree: true });
	observer.observe(list);
	window.visualViewport?.addEventListener("resize", followContent);

	/* ---------- reader intent ---------- */

	list.addEventListener("scroll", () => {
		const next = { top: list.scrollTop, height: list.scrollHeight };
		setPinned(pinnedAfterScroll(pinned, { top: lastTop, height: lastHeight }, next, atEnd()));
		lastTop = next.top;
		lastHeight = next.height;
	});

	list.addEventListener("toggle", (event) => {
		if (hooks.ownsToggle?.(event.target) === true) return;
		const target = event.target;
		// Opening a trace grows the content below the fold: that is the reader's
		// doing, not new output, so it must never drag the view to the end.
		if (!(target instanceof HTMLDetailsElement) || target.open) {
			setPinned(false);
			return;
		}
		// Closing shrinks it, which can land an unpinned reader back on the end
		// without a scroll event — collapsing must not fake new output.
		followContent();
	}, true);

	list.addEventListener(
		"touchstart",
		() => {
			touchOwned = true;
			clearTimeout(touchTimer);
		},
		{ passive: true },
	);
	const releaseTouchSoon = (delay: number): void => {
		clearTimeout(touchTimer);
		touchTimer = window.setTimeout(() => {
			touchOwned = false;
		}, delay);
	};
	list.addEventListener("touchend", () => releaseTouchSoon(180), { passive: true });
	list.addEventListener("touchcancel", () => releaseTouchSoon(180), { passive: true });
	list.addEventListener("scrollend", () => {
		clearTimeout(touchTimer);
		touchOwned = false;
		if (pinned) stickToEnd();
	});

	return {
		get pinned(): boolean {
			return pinned;
		},
		jump(smooth = false): void {
			setPinned(true);
			if (smooth) list.scrollTo({ top: list.scrollHeight, behavior: "smooth" });
			else stickToEnd();
		},
		refresh(): void {
			followContent();
		},
		reset(): void {
			setPinned(true);
			lastTop = 0;
			lastHeight = 0;
		},
	};
}
