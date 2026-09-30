/**
 * Harness tests for the v2 memory extension.
 *
 * Drives the registered tools directly against temp roots with a stubbed
 * ExtensionAPI: no model, no network, no real memory repo.
 *
 *   ./test/run.sh harness
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── environment (must be set before the factory runs) ─────────────────────

const TMP = mkdtempSync(join(tmpdir(), "memory-harness-"));
const AGENT = join(TMP, "agent");
const SHARED = join(TMP, "shared");
process.env.PI_CODING_AGENT_DIR = AGENT;
process.env.PI_MEMORY_DIR = SHARED;

const mod = await import("../index.ts");
const factory = mod.default;

// ── tiny test runner ──────────────────────────────────────────────────────

const tests = [];
let passed = 0;
let failed = 0;

function test(name, fn) {
  tests.push({ name, fn });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

function assertEqual(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg || "values differ"}\n  actual:   ${a}\n  expected: ${e}`);
}

function stubPi() {
  const tools = new Map();
  const handlers = {};
  return {
    registerTool: (def) => tools.set(def.name, def),
    on: (event, fn) => (handlers[event] = fn),
    registerCommand: () => {},
    tools,
    handlers,
  };
}

async function runTool(tool, params) {
  try {
    const result = await tool.execute("call-1", params, undefined, undefined, undefined);
    if ("isError" in result) throw new Error("execute returned `isError` — pi ignores it; throw instead");
    return result;
  } catch (err) {
    return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], details: {}, isError: true };
  }
}

const resultText = (res) => res.content[0].text;

// ── setup ─────────────────────────────────────────────────────────────────

// pi-manager initializes bot repos; simulate that for the agent scope.
mkdirSync(AGENT, { recursive: true });
execFileSync("git", ["-C", AGENT, "init", "-q", "-b", "main"]);
execFileSync("git", ["-C", AGENT, "commit", "--allow-empty", "-q", "-m", "scaffold"]);

const pi = stubPi();
factory(pi);
const search = pi.tools.get("memory_search");
const read = pi.tools.get("memory_read");
const write = pi.tools.get("memory_write");

assert(search && read && write, "memory tools registered");

// ── tests ─────────────────────────────────────────────────────────────────

test("first run creates the layout", () => {
  assert(existsSync(join(AGENT, "notes")), "agent notes dir");
  assert(existsSync(join(SHARED, "notes")) || existsSync(SHARED), "shared root");
  assert(existsSync(join(SHARED, "USER.md")), "USER.md template");
  assert(existsSync(join(SHARED, ".git")), "shared root is a repo");
});

test("write creates a note with frontmatter and an index", async () => {
  const res = await runTool(write, {
    title: "GKS-U deadlines",
    description: "Key dates of the Korean scholarship application — use when planning education deadlines.",
    body: "# GKS-U\n\nEmbassy deadline 30 Sep 12:00.",
    tags: ["education", "grants"],
  });
  assert(!res.isError, `write failed: ${resultText(res)}`);
  assertEqual(res.details.root, "agent");
  assertEqual(res.details.path, "gks-u-deadlines.md");

  const file = readFileSync(join(AGENT, "notes", "gks-u-deadlines.md"), "utf-8");
  assert(file.startsWith("---\n"), "frontmatter");
  assert(file.includes("title: GKS-U deadlines"), "title in frontmatter");
  assert(file.includes("tags: [education, grants]"), "tags in frontmatter");

  const index = readFileSync(join(AGENT, "notes", "index.md"), "utf-8");
  assert(index.includes("GKS-U deadlines"), "index lists the note");
  assert(index.includes("do not edit"), "index marks itself generated");

  const log = execFileSync("git", ["-C", AGENT, "log", "-1", "--format=%s"], { encoding: "utf-8" }).trim();
  assert(/^\[base\] \d{4}-\d{2}-\d{2}T.* wrote agent:gks-u-deadlines\.md$/.test(log), `commit message: ${log}`);
});

test("search finds by text, tag and body", async () => {
  let res = await runTool(search, { query: "korean" });
  assert(!res.isError, resultText(res));
  assert(resultText(res).includes("gks-u-deadlines.md"), "query matches description/title");

  res = await runTool(search, { tags: ["grants"] });
  assert(resultText(res).includes("gks-u-deadlines.md"), "tag matches");

  res = await runTool(search, { query: "embassy" });
  assert(resultText(res).includes("gks-u-deadlines.md"), "body text matches");

  res = await runTool(search, { query: "no-such-thing-anywhere" });
  assert(resultText(res).includes("No notes match"), "empty search is clean");
});

test("search is fuzzy — typos, partial words, any order", async () => {
  const written = await runTool(write, {
    title: "Homelab deployment",
    description: "Layout of the homelab machines and how to deploy services.",
    body: "NixOS hosts behind Caddy.",
    tags: ["homelab"],
    scope: "global",
  });
  assert(!written.isError, resultText(written));

  let res = await runTool(search, { query: "homlab deploment" });
  assert(resultText(res).includes("homelab-deployment.md"), "typos match");

  res = await runTool(search, { query: "deploy homelab" });
  assert(resultText(res).includes("homelab-deployment.md"), "word order does not matter");

  res = await runTool(search, { query: "homel" });
  assert(resultText(res).includes("homelab-deployment.md"), "partial word matches");

  res = await runTool(search, { query: "labhome" });
  assert(!resultText(res).includes("homelab-deployment.md"), "out-of-order letters do not match");

  res = await runTool(search, { tags: ["homelab"] });
  assert(resultText(res).includes("homelab-deployment.md"), "tag still matches");

  res = await runTool(search, { tags: ["homelb"] });
  assert(!resultText(res).includes("homelab-deployment.md"), "tags stay exact");
});

test("search ranks title matches above body-only matches", async () => {
  await runTool(write, {
    title: "Forgejo setup",
    description: "How the Forgejo instance is configured.",
    body: "Runs on the homelab server.",
    scope: "global",
  });
  await runTool(write, {
    title: "Git hosting",
    description: "Where the code repositories live.",
    body: "The Forgejo server runs at git.sudakov.site.",
    scope: "global",
  });
  const res = await runTool(search, { query: "forgejo" });
  const text = resultText(res);
  assert(text.includes("forgejo-setup.md") && text.includes("git-hosting.md"), `both notes found: ${text}`);
  assert(text.indexOf("forgejo-setup.md") < text.indexOf("git-hosting.md"), "title match ranks first");
});

test("fuzzy score: in-order subsequence, compact beats scattered", () => {
  assert(mod.fuzzyScore("homlab", "Homelab deployment") > 0, "typo is a match");
  assertEqual(mod.fuzzyScore("labhome", "Homelab deployment"), undefined, "wrong order is not a match");
  assertEqual(mod.fuzzyScore("zzz", "Homelab deployment"), undefined, "missing letters are not a match");
  const compact = mod.fuzzyScore("deploy", "Homelab deployment");
  const scattered = mod.fuzzyScore("dmt", "Homelab deployment");
  assert(compact !== undefined && scattered !== undefined && compact > scattered, "compact beats scattered");
});

test("read returns the full note", async () => {
  const res = await runTool(read, { root: "agent", path: "gks-u-deadlines.md" });
  assert(!res.isError, resultText(res));
  assert(resultText(res).includes("Embassy deadline"), "body present");
  assert(resultText(res).includes("title: GKS-U deadlines"), "frontmatter present");
});

test("scope global writes to the shared root and stays out of agent scope", async () => {
  const res = await runTool(write, {
    title: "PC GPU",
    description: "Denis's desktop has an RTX 5070 — use when picking local models or CUDA builds.",
    body: "RTX 5070, 12 GB.",
    tags: ["machines"],
    scope: "global",
  });
  assert(!res.isError, resultText(res));
  assertEqual(res.details.root, "global");
  assert(existsSync(join(SHARED, "pc-gpu.md")), "note in shared root");

  const agentOnly = await runTool(search, { query: "RTX", scope: "agent" });
  assert(!resultText(agentOnly).includes("pc-gpu.md"), "not in agent scope");

  const globalOnly = await runTool(search, { query: "RTX", scope: "global" });
  assert(resultText(globalOnly).includes("pc-gpu.md"), "in global scope");

  const all = await runTool(search, { query: "RTX" });
  assert(resultText(all).includes("global:pc-gpu.md"), "root is labelled in results");
});

test("update keeps the original created date and path", async () => {
  const before = readFileSync(join(AGENT, "notes", "gks-u-deadlines.md"), "utf-8");
  const created = before.match(/created: (\S+)/)?.[1];
  const res = await runTool(write, {
    title: "GKS-U deadlines",
    description: "Updated description — use when planning education deadlines.",
    body: "# GKS-U\n\nEmbassy deadline moved.",
    path: "gks-u-deadlines.md",
  });
  assert(!res.isError, resultText(res));
  const after = readFileSync(join(AGENT, "notes", "gks-u-deadlines.md"), "utf-8");
  assert(after.includes(`created: ${created}`), "created preserved");
  assert(after.includes("Updated description"), "description replaced");
  const files = readFileSync(join(AGENT, "notes", "index.md"), "utf-8");
  assertEqual(files.match(/gks-u-deadlines\.md/g).length, 1, "no duplicate entry");
});

test("notes without frontmatter get a fallback title and description", async () => {
  mkdirSync(join(SHARED, "knowledge"), { recursive: true });
  writeFileSync(join(SHARED, "knowledge", "plain-note.md"), "# Zeigarnik result\n\nNo memory advantage for interrupted tasks.\n");
  const res = await runTool(search, { query: "Zeigarnik" });
  assert(resultText(res).includes("knowledge/plain-note.md"), "found by heading");
  assert(resultText(res).includes("Zeigarnik result"), "title from H1");
  assert(resultText(res).includes("No memory advantage"), "description from first line");
});

test("generated index skips itself, system files and archive", async () => {
  mkdirSync(join(SHARED, "archive"), { recursive: true });
  writeFileSync(join(SHARED, "archive", "old.md"), "# Old\n\nSuperseded.\n");
  const res = await runTool(write, {
    title: "Index hygiene",
    description: "Check generated index contents.",
    body: "x",
    scope: "global",
  });
  assert(!res.isError, resultText(res));
  const index = readFileSync(join(SHARED, "index.md"), "utf-8");
  assert(!index.includes("archive/old.md"), "archive excluded");
  assert(!index.includes("USER.md"), "USER excluded");
  assert(!index.includes("memory.md"), "memory.md excluded");
  assert(index.includes("Index hygiene"), "own note included");
});

test("path traversal is rejected", async () => {
  const res = await runTool(write, {
    title: "Escape",
    description: "Should not land outside the notes root.",
    body: "x",
    path: "../escape.md",
  });
  assert(res.isError, "traversal should fail");
  assert(!existsSync(join(AGENT, "escape.md")), "nothing written outside");
});

test("description with a colon survives the round trip", async () => {
  const res = await runTool(write, {
    title: "Colons: a test",
    description: "Use when: testing quoting.",
    body: "body",
  });
  assert(!res.isError, resultText(res));
  const found = await runTool(search, { query: "testing quoting" });
  assert(resultText(found).includes("Colons: a test"), "survived");
});

test("SOUL becomes the preamble and the memory section carries policy and USER", () => {
  writeFileSync(
    join(AGENT, "SOUL.md"),
    "<!-- pi:managed -->\nYou are the dev bot.\n<!-- /pi:managed -->\n\n<!-- a comment -->\n## Voice\nCalm and curious.\n",
  );
  writeFileSync(join(SHARED, "USER.md"), "# Denis\n\nWorks on ML systems.\n");

  const section = mod.buildMemorySection();
  assert(section.includes("Memory is a few files"), "policy present");
  assert(section.includes("Works on ML systems"), "USER present");
  assert(!section.includes("Calm and curious"), "SOUL stays out of the memory section");
  assert(!section.includes("index.md"), "no index content injected");

  const soul = mod.readSoul();
  assert(soul.includes("You are the dev bot."), "managed block kept");
  assert(soul.includes("Calm and curious."), "prose kept");
  assert(!soul.includes("pi:managed"), "marker comments stripped");
  assert(!soul.includes("a comment"), "comments stripped");

  const options = {};
  pi.handlers.before_agent_start({ systemPromptOptions: options });
  assertEqual(options.customPrompt, soul, "preamble from SOUL");
  assert(options.memoryPrompt.includes("Memory is a few files"), "memory section set");
});

test("base agent (agent dir == shared dir) collapses to one note set", async () => {
  const BASE = join(TMP, "base");
  process.env.PI_CODING_AGENT_DIR = BASE;
  process.env.PI_MEMORY_DIR = BASE;
  try {
    const basePi = stubPi();
    factory(basePi);
    const baseWrite = basePi.tools.get("memory_write");
    const res = await runTool(baseWrite, {
      title: "Base note",
      description: "Written by the base agent.",
      body: "x",
      scope: "global",
    });
    assert(!res.isError, resultText(res));
    assertEqual(res.details.root, "agent", "single root is the agent root");
    assert(existsSync(join(BASE, "base-note.md")), "note at the root of the repo");

    const baseSearch = basePi.tools.get("memory_search");
    const found = await runTool(baseSearch, { query: "Base note" });
    assert(resultText(found).includes("base-note.md"), "searchable");
    assertEqual((resultText(found).match(/base-note\.md/g) || []).length, 1, "no duplicate roots");
  } finally {
    delete process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = AGENT;
    process.env.PI_MEMORY_DIR = SHARED;
  }
});

test("BEHAVIOR becomes the behavior section", () => {
  writeFileSync(join(AGENT, "BEHAVIOR.md"), "# Behavior\n\nAsk first.\n<!-- hidden -->\n");
  const behavior = mod.readBehavior();
  assert(behavior.includes("Ask first."), "behavior read");
  assert(!behavior.includes("hidden"), "comments stripped");

  const options = {};
  pi.handlers.before_agent_start({ systemPromptOptions: options });
  assertEqual(options.behaviorPrompt, behavior, "behavior prompt set");
});

test("memoryGlobal: false turns the shared root off", async () => {
  writeFileSync(join(AGENT, "settings.json"), JSON.stringify({ memoryGlobal: false }));
  try {
    const written = await runTool(write, {
      title: "Local only",
      description: "Agent-scope note while the shared root is off.",
      body: "x",
    });
    assert(!written.isError, resultText(written));
    assertEqual(written.details.root, "agent", "agent write works");

    const globalWrite = await runTool(write, {
      title: "Nope",
      description: "Should be refused.",
      body: "x",
      scope: "global",
    });
    assert(globalWrite.isError, "global write refused");

    const globalRead = await runTool(read, { root: "global", path: "pc-gpu.md" });
    assert(globalRead.isError, "global read refused");

    const globalSearch = await runTool(search, { query: "RTX", scope: "global" });
    assert(globalSearch.isError, "global search refused");

    const allSearch = await runTool(search, { query: "Local only" });
    assert(!allSearch.isError && resultText(allSearch).includes("local-only.md"), "all search stays agent-only");

    const section = mod.buildMemorySection();
    assert(section.includes("disabled for this agent"), "policy reflects the toggle");
    assert(!section.includes("=== USER.md ==="), "USER.md not injected");
  } finally {
    rmSync(join(AGENT, "settings.json"), { force: true });
  }
});

// ── run ───────────────────────────────────────────────────────────────────

for (const t of tests) {
  try {
    await t.fn();
    passed++;
    console.log(`  ok    ${t.name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL  ${t.name}`);
    console.error(`        ${String(err.message).split("\n").slice(0, 8).join("\n        ")}`);
  }
}
console.log(`\n${passed}/${tests.length} passed, ${failed} failed`);
rmSync(TMP, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
