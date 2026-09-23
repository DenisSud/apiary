/**
 * house-rules — inject the base rules into every agent's system prompt.
 *
 * The rules live in one file (`global/AGENTS.md`) and reach every agent that
 * loads this package. That includes bots: a bot is its own agent dir, so pi
 * reads context files from there, and the copy under `~/.pi/agent/AGENTS.md`
 * is never seen. Injecting from the package keeps one source of truth — no
 * per-bot copies to sync.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const RULES_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "global",
  "AGENTS.md",
);

function loadRules(): string {
  try {
    return fs.readFileSync(RULES_PATH, "utf8").trim();
  } catch {
    console.error(`house-rules: cannot read ${RULES_PATH}`);
    return "";
  }
}

export default function houseRules(pi: ExtensionAPI) {
  const rules = loadRules();

  pi.on("before_agent_start", async (event) => {
    if (!rules) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\n## House rules\n\n${rules}\n`,
    };
  });
}
