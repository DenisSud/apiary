import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TEMPLATES = join(dirname(fileURLToPath(import.meta.url)), "..", "templates");

function render(file: string, name: string): string {
  return readFileSync(join(TEMPLATES, file), "utf8").replaceAll("{{name}}", name);
}

/** The full SOUL.md for a new bot: identity prose both sides edit. */
export function renderSoul(name: string): string {
  return render("SOUL.md", name);
}

/** The full BEHAVIOR.md for a new bot: always-on working rules both sides edit. */
export function renderBehavior(name: string): string {
  return render("BEHAVIOR.md", name);
}
