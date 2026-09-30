import { blobatarSvg } from "./blob.ts";
import type { BotSummary } from "./types.ts";

// The bot list: one full-row button per bot (avatar + name + state), with the
// open session highlighted. The blobatar's gaze driver is stopped whenever a
// row is rebuilt.

export interface BotList {
	render(bots: BotSummary[], activeBot: string | undefined, busy: boolean): void;
}

export function createBotList(root: HTMLUListElement, onOpen: (name: string) => void): BotList {
	const render = (bots: BotSummary[], activeBot: string | undefined, busy: boolean): void => {
		const fragment = document.createDocumentFragment();
		for (const bot of bots) {
			const item = document.createElement("li");
			const isActive = bot.name === activeBot;
			const runningTurn = isActive && busy;
			item.className = isActive ? "active" : "";
			item.title = bot.dir;

			const meta = document.createElement("div");
			meta.className = "bot-meta";

			const name = document.createElement("span");
			name.className = "bot-name";
			name.textContent = bot.name;

			const state = document.createElement("span");
			state.className = runningTurn ? "bot-state busy" : bot.running ? "bot-state running" : "bot-state";
			state.textContent = runningTurn ? "running a turn" : bot.running ? "server running" : "idle";

			meta.append(name, state);

			// one full-row button: the whole pill is the press target
			const open = document.createElement("button");
			open.className = "bot-open";
			open.type = "button";
			open.onclick = () => onOpen(bot.name);

			const blob = blobatarSvg(bot.name, "avatar", false);
			open.append(blob.element, meta);
			item.append(open);
			fragment.append(item);
		}
		root.replaceChildren(fragment);
	};

	return { render };
}
