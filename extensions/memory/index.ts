/**
 * Pi Memory Extension
 *
 * A general, file-based knowledge repository for the agent — the same
 * abstraction as Pi skills (markdown files + progressive disclosure), but for
 * durable context rather than procedures.
 *
 * Provenance: vendored 2026-09-23 from the `su-memory` package
 * (git.sudakov.site/DenisSud/memory, archived and frozen). It lives in the
 * base now because the repo it came from rejects pushes, and because every
 * bot needs it. The one change: `PI_MEMORY_DIR` lets an agent point at its
 * own clone instead of the shared `~/.pi/agent/memory`.
 *
 * Progressive disclosure:
 *   SOUL.md                              — human-authored identity/values
 *   memory.md                            — global entry point (< 2000 tokens)
 *   <category>/index.md                  — one-line index per file
 *   <category>/<file>.md                 — loaded on demand via `read`
 *
 * Only the always-on files above are injected into the system prompt.
 * Everything else is lazy-loaded by the model with the built-in tools.
 *
 * Skills are deliberately NOT part of memory. Reusable procedures and
 * workflows continue to live in Pi's native skill system. Memory holds:
 *   preferences/  — stable user/agent operating info
 *   projects/     — current or recurring work
 *   knowledge/    — general reusable technical/domain knowledge
 *   archive/      — obsolete material, not loaded
 *
 * No custom tools. No embeddings. No RAG. Just files + git.
 * SPEC.md (this directory) is the original design record — it still lists a
 * `skills/` category, which the implementation deliberately dropped.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// ── Paths ───────────────────────────────────────────────────────────────────

const HOME = process.env.HOME || process.env.USERPROFILE || "";
const MEMORY_DIR = process.env.PI_MEMORY_DIR || path.join(HOME, ".pi/agent/memory");
const SOUL_PATH = path.join(MEMORY_DIR, "SOUL.md");
const MEMORY_PATH = path.join(MEMORY_DIR, "memory.md");

const CATEGORIES = ["preferences", "projects", "knowledge"] as const;
const ARCHIVE = "archive";

// Soft caps on injected file size. These enforce the design invariant that the
// always-loaded set stays small. If a file grows past its cap, only the head is
// injected with a truncation marker, nudging the model to trim it.
const CAPS = { soul: 4000, memory: 8000, index: 4000 } as const;

// ── File templates (created on first run, never overwritten) ────────────────

function soulTemplate(): string {
  return [
    "# SOUL",
    "",
    "You are a technical AI assistant.",
    "Optimize for correctness and long-term usefulness.",
    "Prefer understanding over quick answers.",
    "",
    "<!--",
    "This file defines agent identity, values, and operating principles.",
    "It is human-authored. The agent must never modify it automatically.",
    "-->",
    "",
  ].join("\n");
}

function memoryTemplate(): string {
  return [
    "# User Context",
    "",
    "<!-- Short summary of who the user is and what they work on. -->",
    "",
    "# Important Preferences",
    "",
    "<!-- Global preferences that should always be in context. Keep concise. -->",
    "",
    "# Available Memory",
    "",
    "## Preferences",
    "Stable information about how the user and agent operate.",
    "See preferences/index.md",
    "",
    "## Projects",
    "Active projects and architecture notes.",
    "See projects/index.md",
    "",
    "## Knowledge",
    "Long-term technical knowledge.",
    "See knowledge/index.md",
    "",
  ].join("\n");
}

function indexTemplate(category: string, blurb: string): string {
  return [
    `# ${category.charAt(0).toUpperCase() + category.slice(1)}`,
    "",
    blurb,
    "",
    "<!--",
    "One entry per file in this directory. Keep to:",
    "  filename, one-line description, when to use. Nothing else.",
    "",
    "Example:",
    "## cuda-troubleshooting.md",
    "CUDA initialization failures and driver checks.",
    "Use when:",
    "- CUDA init errors",
    "- driver/torch version mismatch",
    "-->",
    "",
  ].join("\n");
}

const INDEX_BLURBS: Record<(typeof CATEGORIES)[number], string> = {
  preferences: "Stable information about how the user/agent operates.",
  projects: "Current or recurring work.",
  knowledge: "General reusable technical/domain knowledge.",
};

function archiveReadme(): string {
  return [
    "# Archive",
    "",
    "Obsolete memory moved here to keep it out of indexes and active context.",
    "Files here are not loaded automatically.",
    "",
  ].join("\n");
}

function gitignore(): string {
  return ["*.swp", "*~", ".DS_Store", ""].join("\n");
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Read a file, truncating with a marker if it exceeds the cap. */
function readCapped(p: string, cap: number): string {
  try {
    let s = fs.readFileSync(p, "utf-8");
    if (s.length > cap) {
      s =
        s.slice(0, cap) +
        `\n\n…[truncated: ${s.length - cap} chars beyond ${cap}. Trim this file.]`;
    }
    return s.trim() || "(empty)";
  } catch {
    return "(missing)";
  }
}

/** Run a git command inside the memory repo. */
function runGit(args: string[]): { ok: boolean; out: string; err: string } {
  try {
    const out = execFileSync("git", args, {
      cwd: MEMORY_DIR,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, out: out.trim(), err: "" };
  } catch (e: any) {
    return {
      ok: false,
      out: (e?.stdout ?? "").toString().trim(),
      err: ((e?.stderr ?? "").toString().trim() || e?.message || String(e)).trim(),
    };
  }
}

/** Recursively list the memory repo (excluding .git/node_modules) with sizes. */
function listTree(): string {
  const lines: string[] = [];
  const walk = (dir: string, prefix: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries = entries
      .filter((e) => e.name !== ".git" && e.name !== "node_modules")
      .sort((a, b) => {
        // directories first
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        lines.push(`${prefix}${e.name}/`);
        walk(full, prefix + "  ");
      } else {
        let size = 0;
        try {
          size = fs.statSync(full).size;
        } catch {}
        lines.push(`${prefix}${e.name}  (${size}B)`);
      }
    }
  };
  walk(MEMORY_DIR, "");
  return lines.join("\n");
}

// ── First-run setup ─────────────────────────────────────────────────────────

function ensureStructure(): void {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
  for (const cat of CATEGORIES) fs.mkdirSync(path.join(MEMORY_DIR, cat), { recursive: true });
  fs.mkdirSync(path.join(MEMORY_DIR, ARCHIVE), { recursive: true });

  if (!fs.existsSync(SOUL_PATH)) fs.writeFileSync(SOUL_PATH, soulTemplate(), "utf-8");
  if (!fs.existsSync(MEMORY_PATH)) fs.writeFileSync(MEMORY_PATH, memoryTemplate(), "utf-8");
  for (const cat of CATEGORIES) {
    const idx = path.join(MEMORY_DIR, cat, "index.md");
    if (!fs.existsSync(idx)) fs.writeFileSync(idx, indexTemplate(cat, INDEX_BLURBS[cat]), "utf-8");
  }
  const archiveReadmePath = path.join(MEMORY_DIR, ARCHIVE, "README.md");
  if (!fs.existsSync(archiveReadmePath)) fs.writeFileSync(archiveReadmePath, archiveReadme(), "utf-8");

  const gi = path.join(MEMORY_DIR, ".gitignore");
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, gitignore(), "utf-8");

  // Make the memory dir its own git repo.
  if (!fs.existsSync(path.join(MEMORY_DIR, ".git"))) {
    runGit(["init", "--quiet"]);
    // Local identity fallback so commits work without a global git identity.
    if (!runGit(["config", "user.email"]).ok)
      runGit(["config", "user.email", "pi-memory@local"]);
    if (!runGit(["config", "user.name"]).ok) runGit(["config", "user.name", "pi-memory"]);
  }

  // Establish a baseline commit on a fresh repo so `git log` is usable.
  if (!runGit(["log", "-1", "--format=%H"]).ok) {
    runGit(["add", "-A"]);
    runGit(["commit", "-m", "Initialize memory repository"]);
  }
}

// ── Injected policy (kept tight; ~300 tokens) ───────────────────────────────

function policyText(): string {
  return [
    "You maintain a persistent, git-versioned knowledge repository.",
    `Location: ${MEMORY_DIR}`,
    "",
    "Goal: reduce future reasoning cost. Store reusable knowledge, not transcripts.",
    "",
    "In context now (always loaded):",
    "  SOUL.md        — agent identity/values (human-authored; never modify).",
    "  memory.md      — global entry point (keep < 2000 tokens).",
    "  preferences/index.md, projects/index.md, knowledge/index.md — category indexes.",
    "Everything else is loaded on demand with `read`.",
    "",
    "Editing: use `edit`/`write` on file paths under the repository. Use `bash` for",
    "git in that dir. Key commands: `git add`, `git commit -m`, `git log`, `git diff`,",
    "`git revert`, `git pull --rebase`, `git push`.",
    "",
    "Sync workflow (this repo is shared across devices via a remote):",
    "  - Before starting a task: `git pull --rebase origin main`",
    "  - After committing changes: `git push origin main`",
    "  - If pull fails with conflicts: resolve them in the files, then",
    "    `git add` the resolved files and `git rebase --continue`.",
    "",
    "Categories:",
    "  preferences/ — stable info about how the user/agent operate.",
    "  projects/    — current or recurring work (goal, architecture, decisions, state).",
    "  knowledge/   — general reusable technical/domain knowledge.",
    "  archive/     — obsolete files moved out of active context.",
    "Reusable procedures and workflows belong in Pi skills, NOT in memory.",
    "",
    "Write memory only when future work will likely become easier because it exists:",
    "  solved hard problems      -> knowledge/",
    "  repeated user preferences -> preferences/",
    "  project decisions/state   -> projects/",
    "Do NOT store conversation summaries, logs, or transient thoughts.",
    "",
    "Keep each index.md to: filename, one-line description, when-to-use. Nothing else.",
    "Refactor outdated info, split large files, move stale files to archive/.",
    'Commit with short descriptive messages (e.g. "Add CUDA troubleshooting notes").',
    "",
    "Before finishing significant tasks: review for new preferences, decisions, or",
    "solved problems, and update memory if they reduce future effort.",
  ].join("\n");
}

/** Assemble the always-on memory block appended to the system prompt. */
function buildMemoryContext(): string {
  const parts: string[] = ["## Memory", ""];
  parts.push(`Repository: ${MEMORY_DIR} (git-versioned)`, "");

  parts.push("=== SOUL.md ===");
  parts.push(readCapped(SOUL_PATH, CAPS.soul));
  parts.push("");

  parts.push("=== memory.md ===");
  parts.push(readCapped(MEMORY_PATH, CAPS.memory));
  parts.push("");

  for (const cat of CATEGORIES) {
    parts.push(`=== ${cat}/index.md ===`);
    parts.push(readCapped(path.join(MEMORY_DIR, cat, "index.md"), CAPS.index));
    parts.push("");
  }

  parts.push("=== Memory Policy ===");
  parts.push(policyText());

  return parts.join("\n");
}

// ── Extension entry point ───────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  ensureStructure();

  // Inject the always-on memory context (progressive disclosure) before each
  // agent turn. Only SOUL.md, memory.md, and the category indexes are injected;
  // all other files are loaded on demand by the model.
  pi.on("before_agent_start", async (event) => {
    return { systemPrompt: event.systemPrompt + "\n\n" + buildMemoryContext() };
  });

  // /memory — inspect or commit the memory repository.
  pi.registerCommand("memory", {
    description: "Manage the memory repository (/memory [commit <msg>|log|push|pull])",
    handler: async (args, ctx) => {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const sub = tokens[0];

      if (sub === "commit") {
        const msg = tokens.slice(1).join(" ").trim() || "Update memory";
        runGit(["add", "-A"]);
        const res = runGit(["commit", "-m", msg]);
        if (res.ok) ctx.ui.notify(`memory: committed\n${res.out}`, "info");
        else ctx.ui.notify(`memory: ${res.err || "nothing to commit"}`, "info");
        return;
      }

      if (sub === "log") {
        const res = runGit(["log", "--oneline", "-10"]);
        ctx.ui.notify(`memory log\n${res.out || res.err || "no commits"}`, "info");
        return;
      }

      if (sub === "push") {
        const res = runGit(["push", "origin", "main"]);
        if (res.ok) ctx.ui.notify(`memory: pushed\n${res.out || res.err}`, "info");
        else ctx.ui.notify(`memory push failed: ${res.err}`, "error");
        return;
      }

      if (sub === "pull") {
        const res = runGit(["pull", "--rebase", "origin", "main"]);
        if (res.ok) ctx.ui.notify(`memory: pulled\n${res.out || res.err}`, "info");
        else ctx.ui.notify(`memory pull failed: ${res.err}`, "error");
        return;
      }

      // default: status
      const status = runGit(["status", "--short"]);
      const log = runGit(["log", "--oneline", "-5"]);
      const tree = listTree();
      const report = [
        `memory @ ${MEMORY_DIR}`,
        "",
        tree,
        "",
        "--- status ---",
        status.out || status.err || "clean",
        "",
        "--- recent ---",
        log.out || log.err || "no commits",
      ].join("\n");
      ctx.ui.notify(report, "info");
    },
  });
}
