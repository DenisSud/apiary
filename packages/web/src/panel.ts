// The bot panel. Where there is room it is a sidebar that takes its width out
// of the chat; where there is not it is a drawer that pushes the chat right so
// it is cut off at the viewport edge instead of being covered. One owner for
// the layout decision, so the classes on <body> can never fight.

/** Keep in sync with the drawer media query in style.css: the panel's 250px
 *  plus the minimum width the chat needs to stay usable. */
const OVERLAY_QUERY = "(max-width: 650px)";

export interface Panel {
	toggle(): void;
	/** Hide it: the X in the panel, the scrim, or the end of a bot pick. */
	close(): void;
	/** True while the narrow layout is holding the panel over the chat. */
	overlay(): boolean;
}

export function createPanel(elements: { menu: HTMLElement; close: HTMLElement; scrim: HTMLElement }): Panel {
	const narrow = window.matchMedia(OVERLAY_QUERY);
	const body = document.body;
	// The two layouts remember their own state: hiding the sidebar on a wide
	// screen says nothing about the drawer on a phone.
	let sidebarHidden = false;
	let drawerOpen = false;

	function apply(): void {
		if (narrow.matches) {
			body.classList.remove("panel-hidden");
			body.classList.toggle("drawer-open", drawerOpen);
		} else {
			body.classList.remove("drawer-open");
			body.classList.toggle("panel-hidden", sidebarHidden);
		}
	}

	const panel: Panel = {
		toggle() {
			if (narrow.matches) drawerOpen = !drawerOpen;
			else sidebarHidden = !sidebarHidden;
			apply();
		},
		close() {
			if (narrow.matches) drawerOpen = false;
			else sidebarHidden = true;
			apply();
		},
		overlay: () => narrow.matches && drawerOpen,
	};

	elements.menu.addEventListener("click", () => panel.toggle());
	elements.close.addEventListener("click", () => panel.close());
	elements.scrim.addEventListener("click", () => panel.close());
	// Crossing the breakpoint drops the drawer; the wide layout keeps its side.
	narrow.addEventListener("change", () => {
		drawerOpen = false;
		apply();
	});
	apply();
	return panel;
}
