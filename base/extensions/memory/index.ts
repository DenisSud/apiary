/**
 * memory — agent + shared notes with generated indexes.
 *
 * v3 (2026-09-29). The identity is the prompt preamble: <agent dir>/SOUL.md
 * becomes systemPromptOptions.customPrompt (HTML comments stripped), and the
 * extension contributes a <memory> section (policy + USER.md) instead of
 * forcing a whole system prompt. Every note write is committed path-scoped
 * and attributed to the bot; manual commits are not the agent's job.
 *
 * v3.1 (2026-09-30). BEHAVIOR.md becomes the always-on <behavior> section
 * (<agent dir>/BEHAVIOR.md). SOUL.md and BEHAVIOR.md are plain files the
 * agent and its user edit together. `memoryGlobal: false` in the agent's
 * settings.json turns the shared notes root off (agent-only memory).
 *
 * v3.2 (2026-09-30). memory_search matches fuzzily: every query word must
 * match (in any order) as a subsequence with compaction and word-start
 * bonuses, so typos and partial words still match. Results rank by match
 * quality — title/description/tags/path above body — instead of recency;
 * terms under 3 characters match as exact substrings.
 *
 *   <agent dir>/SOUL.md     identity, becomes the preamble
 *   <agent dir>/BEHAVIOR.md operating rules, becomes <behavior>
 *   <agent dir>/notes/      agent notes (frontmatter + body)
 *   ~/.pi/agent/memory/     shared notes; USER.md beside them
 *   notes/index.md          generated from note frontmatter; never agent-edited
 *
 * The base agent (no PI_CODING_AGENT_DIR) uses the shared repo for both, so
 * it has one note set. A bot (PI_CODING_AGENT_DIR set) has its own SOUL and
 * notes, and shares USER.md + the shared notes. PI_MEMORY_DIR is a test
 * override; the service never sets it.
 *
 * Tools: memory_search, memory_read, memory_write. Writes default to the
 * agent scope; `scope: "global"` writes a note another agent will need.
 *
 * Provenance: v1 vendored 2026-09-23 from the archived su-memory package.
 * Design record: the deployment's memory design notes (outside this package).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// ── locations (lazy: tests set the env after import) ────────────────────────

const HOME = process.env.HOME || process.env.USERPROFILE || "";

function sharedDir(): string {
  // PI_MEMORY_DIR is a test override (see the header); bots use the one
  // machine-wide notes repo.
  return path.resolve(process.env.PI_MEMORY_DIR || path.join(HOME, ".pi/agent/memory"));
}

function agentDir(): string {
  return path.resolve(process.env.PI_CODING_AGENT_DIR || sharedDir());
}

export type Scope = "agent" | "global";

interface Root {
  kind: Scope;
  /** The repo root: holds SOUL.md / USER.md / git. */
  dir: string;
  /** Where notes are scanned. Bot notes live in <dir>/notes; the shared repo
   *  is itself the notes folder, so its existing paths keep working. */
  notes: string;
}

/**
 * The note sets. A bot has two: its own and the shared one. The base agent has
 * a single set (agent dir == shared dir), registered as "agent". A bot whose
 * settings say `memoryGlobal: false` has only its own set.
 */
function roots(): Root[] {
  const agent = agentDir();
  const shared = sharedDir();
  const list: Root[] = [];
  const seen = new Set<string>();

  const add = (kind: Scope, dir: string, notes: string) => {
    const key = path.resolve(notes);
    if (seen.has(key)) return;
    seen.add(key);
    list.push({ kind, dir, notes: key });
  };

  if (agent === shared) {
    // Base agent: one generalist set, the shared repo.
    add("agent", agent, agent);
  } else {
    add("agent", agent, path.join(agent, "notes"));
    if (globalMemoryEnabled()) add("global", shared, shared);
  }
  return list;
}

/** `memoryGlobal: false` in the agent's settings.json disables the shared root. */
export function globalMemoryEnabled(): boolean {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(path.join(agentDir(), "settings.json"), "utf-8"));
    return !(raw && typeof raw === "object" && (raw as { memoryGlobal?: unknown }).memoryGlobal === false);
  } catch {
    return true;
  }
}

function rootFor(kind: Scope): Root {
  const all = roots();
  return all.find((r) => r.kind === kind) ?? all[0];
}

function rootsFor(scope: Scope | "all"): Root[] {
  const all = roots();
  if (scope === "all") return all;
  const match = all.filter((r) => r.kind === scope);
  return match.length > 0 ? match : all;
}

/** A global-scope operation on a bot with the shared root disabled. */
function assertGlobalScope(kind: Scope): void {
  if (kind === "global" && !globalMemoryEnabled() && agentDir() !== sharedDir()) {
    throw new Error('memory: the shared (global) notes are disabled for this agent (settings.json "memoryGlobal": false)');
  }
}

// ── frontmatter ─────────────────────────────────────────────────────────────

export interface Meta {
  title: string;
  description: string;
  tags: string[];
  created?: string;
  updated?: string;
}

function unquote(value: string): string {
  const v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return v;
}

function quoteIfNeeded(value: string): string {
  return /^[\w][^{}[\]#:"']*$/.test(value) ? value : `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function parseList(value: string): string[] {
  const v = value.trim();
  if (v.startsWith("[") && v.endsWith("]")) {
    return v
      .slice(1, -1)
      .split(",")
      .map((s) => unquote(s))
      .filter(Boolean);
  }
  return v ? [unquote(v)] : [];
}

/** Minimal YAML-subset parser: flat `key: value`, arrays, quoted strings. */
export function parseFrontmatter(text: string): { meta: Record<string, string | string[]>; body: string } {
  const lines = text.split(/\r?\n/);
  const meta: Record<string, string | string[]> = {};
  if (lines[0] !== "---") return { meta, body: text };

  let i = 1;
  for (; i < lines.length; i++) {
    if (lines[i] === "---") break;
    const m = lines[i].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (m) meta[m[1]] = /^\s*\[/.test(m[2]) ? parseList(m[2]) : unquote(m[2]);
  }
  const body = lines.slice(i + 1).join("\n").replace(/^\s*\n/, "");
  return { meta, body };
}

function firstHeading(body: string): string | undefined {
  return body.match(/^#\s+(.+)$/m)?.[1]?.trim();
}

function firstLine(body: string): string | undefined {
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("<!--") || line.startsWith(">")) continue;
    return line.length > 240 ? `${line.slice(0, 237)}…` : line;
  }
  return undefined;
}

function humanize(file: string): string {
  return path
    .basename(file, ".md")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function metaOf(text: string, rel: string): Meta {
  const { meta, body } = parseFrontmatter(text);
  const tags = Array.isArray(meta.tags) ? meta.tags : typeof meta.tags === "string" ? [meta.tags] : [];
  return {
    title: (typeof meta.title === "string" && meta.title) || firstHeading(body) || humanize(rel),
    description: (typeof meta.description === "string" && meta.description) || firstLine(body) || "",
    tags,
    created: typeof meta.created === "string" ? meta.created : undefined,
    updated: typeof meta.updated === "string" ? meta.updated : undefined,
  };
}

// ── scanning ────────────────────────────────────────────────────────────────

export interface NoteEntry extends Meta {
  root: Scope;
  /** Path relative to the root's notes folder. */
  path: string;
  /** ISO date, from frontmatter `updated` or the file mtime. */
  modified: string;
  body: string;
}

const SKIP_FILES = new Set(["index.md", "USER.md", "SOUL.md", "memory.md", "README.md"]);
const SKIP_DIRS = new Set([".git", "node_modules", "archive", "sessions", "experiments"]);

function walk(dir: string, base: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, base, out);
    } else if (entry.isFile() && entry.name.endsWith(".md") && !SKIP_FILES.has(entry.name)) {
      out.push(path.relative(base, full));
    }
  }
}

function dateOf(root: Root, rel: string): string {
  try {
    return fs.statSync(path.join(root.notes, rel)).mtime.toISOString().slice(0, 10);
  } catch {
    return "";
  }
}

export function scanRoot(root: Root): NoteEntry[] {
  const files: string[] = [];
  walk(root.notes, root.notes, files);
  const entries: NoteEntry[] = [];
  for (const rel of files) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(root.notes, rel), "utf-8");
    } catch {
      continue;
    }
    const meta = metaOf(text, rel);
    entries.push({
      ...meta,
      root: root.kind,
      path: rel,
      modified: meta.updated || dateOf(root, rel),
      body: parseFrontmatter(text).body,
    });
  }
  entries.sort((a, b) => b.modified.localeCompare(a.modified) || a.title.localeCompare(b.title));
  return entries;
}

/** Regenerate a root's index.md. Generated only — the agent never edits it. */
export function writeIndex(root: Root): void {
  fs.mkdirSync(root.notes, { recursive: true });
  const entries = scanRoot(root);
  const lines = [
    "<!-- generated by the memory extension; do not edit — edit the notes -->",
    "",
    `# Notes (${entries.length})`,
    "",
  ];
  for (const e of entries) {
    const tags = e.tags.length > 0 ? ` {${e.tags.join(", ")}}` : "";
    lines.push(`- [${e.title}](${e.path}) — ${e.description}${tags} · ${e.modified}`);
  }
  fs.writeFileSync(path.join(root.notes, "index.md"), `${lines.join("\n")}\n`, "utf-8");
}

// ── tools ───────────────────────────────────────────────────────────────────

const text = (t: string) => [{ type: "text" as const, text: t }];

// ── search ──────────────────────────────────────────────────────────────────

const GAP_LEADING = -0.005;
const GAP_INNER = -0.01;
const GAP_TRAILING = -0.005;
const MATCH_CONSECUTIVE = 1;
const MATCH_FIRST = 0.85;
const MATCH_SLASH = 0.9;
const MATCH_WORD = 0.8;
const MATCH_CAPITAL = 0.7;
const MATCH_DOT = 0.6;

/** Position bonus: field start, after a separator, or a camelCase hump. */
function bonusAt(prev: string, cur: string): number {
  if (prev === "") return MATCH_FIRST;
  if (prev === "/") return MATCH_SLASH;
  if (prev === " " || prev === "-" || prev === "_") return MATCH_WORD;
  if (prev === ".") return MATCH_DOT;
  if (prev === prev.toLowerCase() && cur !== cur.toLowerCase() && /[A-Za-z]/.test(cur)) return MATCH_CAPITAL;
  return 0;
}

/**
 * fzy-style fuzzy score: `term` must be a subsequence of `text` (case-
 * insensitive); compact runs and word starts score higher, gaps lower. Returns
 * undefined when there is no match. O(len(text) × len(term)).
 */
export function fuzzyScore(term: string, text: string): number | undefined {
  const t = term.toLowerCase();
  const s = text.toLowerCase();
  const n = t.length;
  const m = s.length;
  if (n === 0 || n > m) return undefined;

  // D[j]: best score matching term[0..i] with term[i] at s[j].
  // M[j]: best score matching term[0..i] ending at or before j.
  let prevD = new Array<number>(m).fill(-Infinity);
  let prevM = new Array<number>(m).fill(-Infinity);
  for (let j = 0; j < m; j++) {
    if (s[j] === t[0]) prevD[j] = j * GAP_LEADING + bonusAt(j === 0 ? "" : s[j - 1], text[j]);
    prevM[j] = Math.max(j > 0 ? prevM[j - 1] + GAP_INNER : -Infinity, prevD[j]);
  }
  for (let i = 1; i < n; i++) {
    const curD = new Array<number>(m).fill(-Infinity);
    const curM = new Array<number>(m).fill(-Infinity);
    for (let j = i; j < m; j++) {
      if (s[j] === t[i]) {
        curD[j] = Math.max(prevD[j - 1] + MATCH_CONSECUTIVE, prevM[j - 1]) + bonusAt(s[j - 1], text[j]);
      }
      curM[j] = Math.max(curD[j], j > i ? curM[j - 1] + GAP_INNER : -Infinity);
    }
    prevD = curD;
    prevM = curM;
  }

  let best = -Infinity;
  for (let j = n - 1; j < m; j++) {
    if (prevD[j] > -Infinity) best = Math.max(best, prevD[j] + (m - 1 - j) * GAP_TRAILING);
  }
  return best === -Infinity ? undefined : best;
}

/** Terms shorter than this match as exact substrings; fuzzy is noisy below it. */
const FUZZY_MIN = 3;
/** Field weights for query matching: metadata outranks body text. */
const FIELD_WEIGHTS = { title: 3, description: 2, tags: 2, path: 1.5 };
const BODY_WEIGHT = 1;
const BODY_FUZZY_WEIGHT = 0.6;

interface LowerFields {
  title: string;
  description: string;
  tags: string;
  path: string;
  body: string;
}

function lowered(entry: NoteEntry): LowerFields {
  return {
    title: entry.title.toLowerCase(),
    description: entry.description.toLowerCase(),
    tags: entry.tags.join(" ").toLowerCase(),
    path: entry.path.toLowerCase(),
    body: entry.body.toLowerCase(),
  };
}

/** One term against one field: fuzzy when long enough, else exact substring. */
function fieldScore(term: string, raw: string, low: string): number | undefined {
  if (term.length >= FUZZY_MIN) return fuzzyScore(term, raw);
  return low.includes(term) ? term.length + 0.5 : undefined;
}

/** Strict fuzzy over body words: typo tolerance without matching all of the body. */
function bodyWordScore(term: string, lowBody: string): number | undefined {
  const min = Math.max(FUZZY_MIN, term.length - 2);
  const max = term.length + 2;
  let best: number | undefined;
  for (const word of lowBody.split(/[^a-z0-9]+/)) {
    if (word.length < min || word.length > max) continue;
    const s = fuzzyScore(term, word);
    if (s !== undefined && (best === undefined || s > best)) best = s;
  }
  return best !== undefined && best >= term.length * 0.75 ? best : undefined;
}

/**
 * Score one query term against one note; undefined when it does not match.
 * The best field wins (no double counting); metadata weights outrank body.
 */
function termScore(term: string, entry: NoteEntry, low: LowerFields): number | undefined {
  let best: number | undefined;
  const take = (value: number | undefined, weight: number) => {
    if (value === undefined) return;
    const s = value * weight;
    if (best === undefined || s > best) best = s;
  };

  take(fieldScore(term, entry.title, low.title), FIELD_WEIGHTS.title);
  take(fieldScore(term, entry.description, low.description), FIELD_WEIGHTS.description);
  take(fieldScore(term, entry.tags.join(" "), low.tags), FIELD_WEIGHTS.tags);
  take(fieldScore(term, entry.path, low.path), FIELD_WEIGHTS.path);

  if (low.body.includes(term)) take(term.length, BODY_WEIGHT);
  else if (term.length >= FUZZY_MIN) take(bodyWordScore(term, low.body), BODY_FUZZY_WEIGHT);

  return best;
}

function tagsMatch(entry: NoteEntry, tags: string[]): boolean {
  if (tags.length === 0) return true;
  const own = entry.tags.map((t) => t.toLowerCase());
  return tags.every((t) => own.includes(t.toLowerCase()));
}

function safePath(root: Root, rel: string): string {
  const clean = rel.replace(/\\/g, "/").replace(/^\/+/, "");
  const abs = path.resolve(root.notes, clean);
  const prefix = root.notes.endsWith(path.sep) ? root.notes : root.notes + path.sep;
  if (abs !== root.notes && !abs.startsWith(prefix)) {
    throw new Error(`memory: path escapes the notes folder: ${rel}`);
  }
  return abs;
}

function slug(title: string): string {
  const s = title
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 64);
  return s || "note";
}

function serialize(meta: Meta, body: string): string {
  const lines = ["---", `title: ${quoteIfNeeded(meta.title)}`, `description: ${quoteIfNeeded(meta.description)}`];
  if (meta.tags.length > 0) lines.push(`tags: [${meta.tags.map(quoteIfNeeded).join(", ")}]`);
  if (meta.created) lines.push(`created: ${meta.created}`);
  if (meta.updated) lines.push(`updated: ${meta.updated}`);
  lines.push("---", "", body.trim(), "");
  return lines.join("\n");
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// ── first-run setup ─────────────────────────────────────────────────────────

const USER_TEMPLATE = [
  "# User",
  "",
  "<!-- Shared profile: who the user is, their environment, global preferences.",
  "     Every agent reads this. Change it rarely, through memory_write with",
  "     scope \"global\", and say so in chat. -->",
  "",
  "## Identity",
  "",
  "## Environment",
  "",
  "## How to work with him",
  "",
].join("\n");

function runGit(dir: string, args: string[]): { ok: boolean; out: string; err: string } {
  try {
    const out = execFileSync("git", args, { cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, out: out.trim(), err: "" };
  } catch (e: any) {
    return { ok: false, out: (e?.stdout ?? "").toString().trim(), err: ((e?.stderr ?? "").toString().trim() || e?.message || "").trim() };
  }
}

function botLabel(): string {
  const name = process.env.PI_BOT_NAME?.trim();
  return name ? name : "base";
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Commit a note and its index path-scoped, attributed to the editing agent. */
function commitMemory(root: Root, rel: string, verb: string): string | undefined {
  if (!fs.existsSync(path.join(root.dir, ".git"))) return undefined;
  const paths = [
    path.relative(root.dir, path.join(root.notes, rel)),
    path.relative(root.dir, path.join(root.notes, "index.md")),
  ];
  const message = `[${botLabel()}] ${new Date().toISOString()} ${verb} ${root.kind}:${rel}`;
  let error = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const add = runGit(root.dir, ["add", "--", ...paths]);
    if (!add.ok) {
      error = add.err || add.out;
      break;
    }
    const commit = runGit(root.dir, [
      "-c",
      "user.name=pi-bots",
      "-c",
      "user.email=pi-bots@localhost",
      "commit",
      "-q",
      "-m",
      message,
      "--",
      ...paths,
    ]);
    if (commit.ok) return undefined;
    error = commit.err || commit.out;
    if (/nothing to commit|no changes added/.test(error)) return undefined;
    if (!error.includes("index.lock")) break;
    sleepSync(150);
  }
  return error || "commit failed";
}

function ensureStructure(): void {
  const shared = sharedDir();
  const agent = agentDir();

  fs.mkdirSync(shared, { recursive: true });
  if (agent !== shared) fs.mkdirSync(path.join(agent, "notes"), { recursive: true });
  for (const root of roots()) fs.mkdirSync(root.notes, { recursive: true });

  const user = path.join(shared, "USER.md");
  if (!fs.existsSync(user) && !fs.existsSync(path.join(shared, "memory.md"))) {
    fs.writeFileSync(user, USER_TEMPLATE, "utf-8");
  }
  const soul = path.join(shared, "SOUL.md");
  if (!fs.existsSync(soul) && agent === shared) {
    fs.writeFileSync(
      soul,
      "# SOUL\n\n<!-- Identity, voice, values. Human-authored; the agent never edits this file. -->\n",
      "utf-8",
    );
  }

  // A fresh shared root becomes a git repo, like v1 did.
  if (!fs.existsSync(path.join(shared, ".git"))) {
    const res = runGit(shared, ["init", "--quiet"]);
    if (res.ok) {
      for (const file of ["USER.md", "SOUL.md"]) {
        if (fs.existsSync(path.join(shared, file))) runGit(shared, ["add", "--", file]);
      }
      runGit(shared, [
        "-c",
        "user.name=pi-bots",
        "-c",
        "user.email=pi-bots@localhost",
        "commit",
        "-q",
        "-m",
        "Initialize memory",
      ]);
    }
  }
}

// ── system-prompt block ─────────────────────────────────────────────────────

function readCapped(file: string, cap: number): string {
  try {
    const content = fs.readFileSync(file, "utf-8").trim();
    if (!content) return "(empty)";
    return content.length > cap ? `${content.slice(0, cap)}\n…[truncated ${content.length - cap} chars]` : content;
  } catch {
    return "(missing)";
  }
}

function soulFile(): string {
  const agent = agentDir();
  const local = path.join(agent, "SOUL.md");
  if (fs.existsSync(local)) return local;
  return path.join(sharedDir(), "SOUL.md");
}

function behaviorFile(): string {
  const agent = agentDir();
  const local = path.join(agent, "BEHAVIOR.md");
  if (fs.existsSync(local)) return local;
  return path.join(sharedDir(), "BEHAVIOR.md");
}

function userFile(): string {
  const shared = sharedDir();
  const user = path.join(shared, "USER.md");
  if (fs.existsSync(user)) return user;
  return path.join(shared, "memory.md");
}

function policyText(): string {
  const agent = agentDir();
  const shared = sharedDir();
  const agentNotes = agent === shared ? shared : path.join(agent, "notes");
  const global = globalMemoryEnabled() && agent !== shared;
  const lines = [
    "Memory is a few files, not a database:",
    "",
    `- Agent notes: ${agentNotes}`,
    "- SOUL.md is who you are and BEHAVIOR.md is how you work; both are plain",
    "  files you and your user edit together, and the service applies changes",
    "  on your next commit.",
  ];
  if (global) {
    lines.push(`- Shared notes: ${shared}`);
    lines.push("- USER.md is the shared profile of the user. Read it; update it rarely.");
  } else {
    lines.push("- The shared notes and USER.md are disabled for this agent (memoryGlobal: false).");
  }
  lines.push(
    "- Everything else is a note with frontmatter. Title + description are the",
    "  index; the body is read only when the description matches.",
    "- memory_search before researching anything — it matches words fuzzily,",
    "  in any order, and ranks the best matches first. memory_read to load a",
    "  note; memory_write to create or update one. Update the existing note",
    "  when the topic exists.",
    "- Write durable findings, decisions and state as notes — never transcripts",
    "  or transient thoughts.",
    '- Default scope is "agent". Use scope "global" only when another agent',
    "  needs the fact (shared projects, machines, the user's profile, cross-track",
    "  deadlines), and say in chat what you moved there.",
    "- Mark a replaced note `status: superseded` with a link instead of",
    "  deleting it.",
    "- Every write is committed for you, path-scoped, with a timestamp and your",
    "  name. Do not run git in the memory dirs yourself.",
  );
  return lines.join("\n");
}

function stripComments(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function readTextCapped(file: string, cap: number): string | undefined {
  try {
    const content = fs.readFileSync(file, "utf-8").trim();
    if (!content) return undefined;
    return content.length > cap ? `${content.slice(0, cap)}\n…[truncated ${content.length - cap} chars]` : content;
  } catch {
    return undefined;
  }
}

/** The agent's identity preamble: SOUL.md without comments. */
export function readSoul(): string | undefined {
  const content = readTextCapped(soulFile(), 6000);
  if (content === undefined) return undefined;
  return stripComments(content) || undefined;
}

/** The agent's always-on operating rules: BEHAVIOR.md without comments. */
export function readBehavior(): string | undefined {
  const content = readTextCapped(behaviorFile(), 6000);
  if (content === undefined) return undefined;
  return stripComments(content) || undefined;
}

/** The <memory> section: notes policy plus the shared user profile. */
export function buildMemorySection(): string {
  const lines = [policyText()];
  if (globalMemoryEnabled() && agentDir() !== sharedDir()) {
    lines.push("", "=== USER.md ===", readCapped(userFile(), 8000));
  }
  return lines.join("\n");
}

// ── extension ───────────────────────────────────────────────────────────────

export default function memory(pi: ExtensionAPI) {
  ensureStructure();
  for (const root of roots()) {
    try {
      writeIndex(root);
    } catch {
      // A broken note must not take the session down; index regenerates later.
    }
  }

  pi.on("before_agent_start", (event) => {
    const soul = readSoul();
    if (soul !== undefined) event.systemPromptOptions.customPrompt = soul;
    const behavior = readBehavior();
    if (behavior !== undefined) event.systemPromptOptions.behaviorPrompt = behavior;
    event.systemPromptOptions.memoryPrompt = buildMemorySection();
  });

  pi.registerTool({
    name: "memory_search",
    label: "Memory Search",
    description:
      'Search your notes and the shared notes. Every word in `query` must match somewhere in one note (AND), in any order; matching is fuzzy — typos and partial words match (e.g. "homlab deploment" finds "Homelab deployment"). Results rank by match quality, not by date: title, description, tags and path outrank a body-only match. `tags` are exact and must all be present. Returns `scope:path — title — description {tags} · updated` lines; load one with memory_read. Use before researching anything, and when looking for an earlier decision or state.',
    parameters: Type.Object({
      query: Type.Optional(
        Type.String({
          description:
            'Words to find. All must match, fuzzy and in any order; fewer distinctive words work best (e.g. "homelab deploy").',
        }),
      ),
      tags: Type.Optional(Type.Array(Type.String({ description: "Exact tag names; all must be present (results show tags as {a, b})" }))),
      scope: Type.Optional(
        Type.Union([Type.Literal("agent"), Type.Literal("global"), Type.Literal("all")], {
          description: 'Where to search (default "all": your notes plus the shared ones)',
        }),
      ),
      limit: Type.Optional(Type.Number({ description: "Maximum results (default 20, max 50)" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (params.scope) assertGlobalScope(params.scope);
      const terms = (params.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const tags = params.tags ?? [];
      const limit = Math.min(50, Math.max(1, Math.round(params.limit ?? 20)));
      const found: { entry: NoteEntry; score: number }[] = [];
      for (const root of rootsFor(params.scope ?? "all")) {
        for (const entry of scanRoot(root)) {
          if (!tagsMatch(entry, tags)) continue;
          if (terms.length === 0) {
            found.push({ entry, score: 0 });
            continue;
          }
          const low = lowered(entry);
          let score = 0;
          let matches = true;
          for (const term of terms) {
            const s = termScore(term, entry, low);
            if (s === undefined) {
              matches = false;
              break;
            }
            score += s;
          }
          if (matches) found.push({ entry, score });
        }
      }
      found.sort(
        (a, b) =>
          b.score - a.score ||
          b.entry.modified.localeCompare(a.entry.modified) ||
          a.entry.title.localeCompare(b.entry.title),
      );
      const shown = found.slice(0, limit);

      let formatted: string;
      if (shown.length === 0 && !params.query && tags.length === 0) {
        formatted = "No notes yet.";
      } else if (shown.length === 0) {
        const want = params.query
          ? tags.length > 0
            ? ` "${params.query}" with tags {${tags.join(", ")}}`
            : ` "${params.query}"`
          : ` with tags {${tags.join(", ")}}`;
        const hint =
          terms.length > 0
            ? ` Try fewer or shorter words${tags.length > 0 ? " or drop a tag" : ""} — every word${
                tags.length > 0 ? " and tag" : ""
              } must match.`
            : " Try other tags — tags are exact.";
        formatted = `No notes match${want}.${hint}`;
      } else {
        formatted =
          shown
            .map(({ entry: e }) => {
              const tagText = e.tags.length > 0 ? ` {${e.tags.join(", ")}}` : "";
              return `- ${e.root}:${e.path} — ${e.title} — ${e.description}${tagText} · ${e.modified}`;
            })
            .join("\n") + (found.length > limit ? `\n… ${found.length - limit} more` : "");
      }

      return {
        content: text(formatted),
        details: {
          count: found.length,
          entries: shown.map(({ entry: e, score }) => ({
            root: e.root,
            path: e.path,
            title: e.title,
            score: Math.round(score * 100) / 100,
          })),
        },
      };
    },
  });

  pi.registerTool({
    name: "memory_read",
    label: "Memory Read",
    description: "Read one note by root and path, as returned by memory_search.",
    parameters: Type.Object({
      root: Type.Union([Type.Literal("agent"), Type.Literal("global")], { description: "Which note set" }),
      path: Type.String({ description: "Path relative to the notes folder, from memory_search" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      assertGlobalScope(params.root);
      const root = rootFor(params.root);
      const abs = safePath(root, params.path);
      if (!fs.existsSync(abs)) throw new Error(`memory_read: no such note: ${params.root}:${params.path}`);
      return {
        content: text(fs.readFileSync(abs, "utf-8")),
        details: { root: root.kind, path: params.path },
      };
    },
  });

  pi.registerTool({
    name: "memory_write",
    label: "Memory Write",
    description:
      "Create or update a note with frontmatter (title, description, tags). Description is the retrieval key — write it as \"use when…\". Defaults to your own notes; scope \"global\" writes to the shared set when another agent will need the fact, and you should say so in chat.",
    parameters: Type.Object({
      title: Type.String({ description: "Short note title" }),
      description: Type.String({ description: 'One line: when this note is useful ("use when…")' }),
      body: Type.String({ description: "The note, markdown" }),
      tags: Type.Optional(Type.Array(Type.String())),
      scope: Type.Optional(Type.Union([Type.Literal("agent"), Type.Literal("global")], { description: 'Default "agent"' })),
      path: Type.Optional(
        Type.String({ description: "Existing note path to update, or a new path (e.g. projects/work.md); default: slug of the title" }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const scope = params.scope ?? "agent";
      assertGlobalScope(scope);
      const root = rootFor(scope);
      const tags = params.tags ?? [];
      if (!params.title.trim()) throw new Error("memory_write: title is required");
      if (!params.description.trim()) throw new Error("memory_write: description is required");

      let rel: string;
      let created: string | undefined;
      if (params.path) {
        rel = params.path.replace(/\\/g, "/").replace(/^\/+/, "");
        if (!rel.endsWith(".md")) rel += ".md";
        const abs = safePath(root, rel);
        if (fs.existsSync(abs)) {
          const existing = parseFrontmatter(fs.readFileSync(abs, "utf-8")).meta;
          created = typeof existing.created === "string" ? existing.created : undefined;
        }
      } else {
        rel = `${slug(params.title)}.md`;
        let candidate = rel;
        let n = 2;
        while (fs.existsSync(safePath(root, candidate))) candidate = `${rel.replace(/\.md$/, "")}-${n++}.md`;
        rel = candidate;
      }

      const abs = safePath(root, rel);
      const meta: Meta = {
        title: params.title.trim(),
        description: params.description.trim(),
        tags: tags.map((t) => t.trim()).filter(Boolean),
        created: created ?? today(),
        updated: today(),
      };
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, serialize(meta, params.body), "utf-8");
      writeIndex(root);

      const verb = created ? "updated" : "wrote";
      const commitError = commitMemory(root, rel, verb);
      return {
        content: text(
          commitError === undefined
            ? `${verb} ${root.kind}:${rel} — committed.`
            : `${verb} ${root.kind}:${rel} — commit failed: ${commitError}`,
        ),
        details: { root: root.kind, path: rel },
      };
    },
  });
}
