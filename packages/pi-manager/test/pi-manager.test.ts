import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import {
  DEFAULT_BOT_MODEL,
  DEFAULT_TOOL_FLOOR,
  adminSettingsPath,
  applyMarker,
  archiveBot,
  basePackageDir,
  baseSourceFor,
  botDir,
  createBot,
  deleteBot,
  ensureInvariants,
  isApplyPending,
  isSetupPending,
  listBots,
  postCommitHookPath,
  readBot,
  setupMarker,
  unarchiveBot,
  updateBot,
} from "../src/index.ts";

const roots: string[] = [];

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  delete process.env.PI_BOT_MODEL;
});

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-manager-"));
  roots.push(root);
  const shared = join(root, "agent");
  mkdirSync(shared, { recursive: true });
  for (const file of ["auth.json", "models.json", "models-store.json", "trust.json"]) {
    writeFileSync(join(shared, file), "{}\n");
  }
  writeFileSync(
    join(shared, "settings.json"),
    `${JSON.stringify(
      { defaultProvider: "openai", defaultModel: "gpt-5", theme: "dark", packages: ["/elsewhere"] },
      null,
      2,
    )}\n`,
  );
  process.env.APIARY_HOME = join(root, "Bots");
  process.env.PI_SHARED_AGENT_DIR = shared;
  return root;
}

function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-C", dir, "-c", "user.name=test", "-c", "user.email=test@localhost", ...args], {
    encoding: "utf8",
  }).trim();
}

function gitLog(dir: string): string[] {
  return git(dir, ["log", "--format=%s"]).split("\n");
}

function commit(dir: string, paths: string[], message: string): void {
  execFileSync("git", ["-C", dir, "add", "--", ...paths], { encoding: "utf8" });
  execFileSync(
    "git",
    ["-C", dir, "-c", "user.name=test", "-c", "user.email=test@localhost", "commit", "-q", "-m", message, "--", ...paths],
    { encoding: "utf8" },
  );
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function readSettings(dir: string): Record<string, unknown> {
  return readJson(join(dir, "settings.json"));
}

test("create makes the shared agent dir when it is missing", async () => {
  const root = freshRoot();
  const shared = join(root, "fresh-agent");
  process.env.PI_SHARED_AGENT_DIR = shared;
  assert.equal(existsSync(shared), false);
  await createBot({ name: "dev" });
  assert.ok(existsSync(shared), "shared agent dir was not created");
  for (const file of ["auth.json", "models.json", "models-store.json", "trust.json"]) {
    assert.ok(lstatSync(join(botDir("dev"), file)).isSymbolicLink(), `${file} is not a symlink`);
  }
});

test("create scaffolds a bot and inherits shared settings", async () => {
  freshRoot();
  const detail = await createBot({ name: "dev" });
  const dir = botDir("dev");

  for (const file of ["SOUL.md", "BEHAVIOR.md", "settings.json", ".gitignore", "skills", "extensions", "notes", "sessions"]) {
    assert.ok(existsSync(join(dir, file)), `missing ${file}`);
  }
  for (const file of ["auth.json", "models.json", "models-store.json", "trust.json"]) {
    assert.ok(lstatSync(join(dir, file)).isSymbolicLink(), `${file} is not a symlink`);
  }

  const soul = readFileSync(join(dir, "SOUL.md"), "utf8");
  assert.match(soul, /You are \*\*dev\*\*/);
  assert.match(soul, /## Boundaries/);
  assert.doesNotMatch(soul, /pi:managed/);
  assert.match(readFileSync(join(dir, "BEHAVIOR.md"), "utf8"), /# Behavior/);

  const settings = readSettings(dir);
  assert.equal(settings.defaultModel, "gpt-5");
  assert.equal(settings.theme, "dark");
  assert.deepEqual(settings.defaultTools, [...DEFAULT_TOOL_FLOOR]);
  const packages = settings.packages as string[];
  assert.equal(packages.length, 1);
  assert.equal(resolve(dir, packages[0]!), basePackageDir());

  // setup is in progress until the agent's `init` commit.
  assert.equal(detail.setup, true);
  assert.ok(existsSync(setupMarker(dir)));
  assert.equal(isApplyPending(dir), false);
  const hook = postCommitHookPath(dir);
  assert.ok(existsSync(hook));
  assert.ok(statSync(hook).mode & 0o100, "hook is not executable");

  // admin settings are materialized for the server to read.
  const admin = readJson(adminSettingsPath(dir));
  assert.equal(admin.defaultProvider, DEFAULT_BOT_MODEL.provider);
  assert.equal(admin.defaultModel, DEFAULT_BOT_MODEL.id);
  assert.deepEqual(admin.defaultTools, [...DEFAULT_TOOL_FLOOR]);
  assert.equal(resolve(dir, (admin.packages as string[])[0]!), basePackageDir());

  assert.deepEqual(gitLog(dir), ["Scaffold dev"]);
  assert.deepEqual(detail.packages, []);
  assert.deepEqual(detail.model, DEFAULT_BOT_MODEL);
  assert.equal(detail.archived, false);
  assert.deepEqual(listBots().map((bot) => bot.name), ["dev"]);
  assert.deepEqual(listBots()[0]!.setup, true);
});

test("create stores thinking and packages", async () => {
  const root = freshRoot();
  const extra = join(root, "extra-pkg");
  mkdirSync(extra, { recursive: true });

  const detail = await createBot({
    name: "writer",
    packages: [extra],
    thinking: "high",
  });
  const dir = botDir("writer");
  const settings = readSettings(dir);
  assert.equal(settings.defaultThinkingLevel, "high");
  assert.equal(detail.packages.length, 1);
  assert.equal(resolve(dir, detail.packages[0]!), extra);
  assert.equal(detail.thinking, "high");
  // The enforced model is reported as-is regardless of the scaffold's fields.
  assert.deepEqual(detail.model, DEFAULT_BOT_MODEL);

  const updated = await updateBot("writer", { packages: [] });
  assert.deepEqual(updated.packages, []);
  const packages = readSettings(dir).packages as string[];
  assert.equal(packages.length, 1);

  await assert.rejects(updateBot("writer", { thinking: "ultra" as never }), /invalid thinking level/);
});

test("the init commit ends setup and later config commits apply", async () => {
  freshRoot();
  await createBot({ name: "dev" });
  const dir = botDir("dev");

  // A non-init setup commit does not apply.
  writeFileSync(join(dir, "BEHAVIOR.md"), "# Behavior\n\nAsk first.\n");
  commit(dir, ["BEHAVIOR.md"], "wip: behavior");
  assert.ok(existsSync(setupMarker(dir)));
  assert.equal(isApplyPending(dir), false);

  // The init commit applies, clears the marker and records the apply.
  writeFileSync(join(dir, "BEHAVIOR.md"), "# Behavior\n\nAsk first, then act.\n");
  commit(dir, ["BEHAVIOR.md"], "init");
  assert.equal(existsSync(setupMarker(dir)), false);
  assert.equal(isApplyPending(dir), true);

  // Notes-only commits never apply.
  rmSync(applyMarker(dir), { force: true });
  mkdirSync(join(dir, "notes", "work"), { recursive: true });
  writeFileSync(join(dir, "notes", "work", "state.md"), "state\n");
  commit(dir, ["notes/work/state.md"], "notes: state");
  assert.equal(isApplyPending(dir), false);

  // Settings commits apply, and updateBot commits settings too.
  await updateBot("dev", { thinking: "low" });
  assert.equal(isApplyPending(dir), true);
});

test("reconciler restores missing files and the admin layer", async () => {
  freshRoot();
  await createBot({ name: "dev" });
  const dir = botDir("dev");
  rmSync(join(dir, "SOUL.md"));
  rmSync(join(dir, "BEHAVIOR.md"));
  rmSync(adminSettingsPath(dir));
  rmSync(postCommitHookPath(dir));

  const actions = await ensureInvariants("dev");
  assert.deepEqual(actions, { createdSoul: true, createdBehavior: true });
  assert.match(readFileSync(join(dir, "SOUL.md"), "utf8"), /You are \*\*dev\*\*/);
  assert.ok(existsSync(adminSettingsPath(dir)));
  assert.ok(existsSync(postCommitHookPath(dir)));
  assert.deepEqual(readBot("dev").model, DEFAULT_BOT_MODEL);

  // A second run changes nothing.
  assert.deepEqual(await ensureInvariants("dev"), { createdSoul: false, createdBehavior: false });
});

test("the model and mandatory packages come from the deployment env", async () => {
  const root = freshRoot();
  const one = join(root, "mandatory-one");
  const two = join(root, "mandatory-two");
  mkdirSync(one, { recursive: true });
  mkdirSync(two, { recursive: true });
  process.env.PI_BOT_MODEL = "anthropic/claude-sonnet-4";
  process.env.PI_BOT_PACKAGES = `${one}, ${two}`;
  try {
    await createBot({ name: "envbot" });
    const dir = botDir("envbot");
    const admin = readJson(adminSettingsPath(dir));
    assert.equal(admin.defaultProvider, "anthropic");
    assert.equal(admin.defaultModel, "claude-sonnet-4");
    assert.deepEqual(admin.packages, [baseSourceFor(dir), one, two]);
    assert.deepEqual(readBot("envbot").model, { provider: "anthropic", id: "claude-sonnet-4" });
  } finally {
    delete process.env.PI_BOT_MODEL;
    delete process.env.PI_BOT_PACKAGES;
  }
});

test("archive hides the bot until unarchive", async () => {
  freshRoot();
  await createBot({ name: "dev" });
  const dir = botDir("dev");

  assert.equal(archiveBot("dev").archived, true);
  assert.ok(existsSync(join(dir, ".archived")));
  assert.deepEqual(listBots(), []);
  assert.deepEqual(
    listBots({ includeArchived: true }).map((bot) => bot.name),
    ["dev"],
  );

  assert.equal(unarchiveBot("dev").archived, false);
  assert.ok(!existsSync(join(dir, ".archived")));
  assert.deepEqual(gitLog(dir), ["Scaffold dev"]);
});

test("delete requires the exact name", async () => {
  freshRoot();
  await createBot({ name: "dev" });
  const dir = botDir("dev");
  assert.throws(() => deleteBot("dev", { confirm: "nope" }), /confirm/);
  assert.ok(existsSync(dir));
  deleteBot("dev", { confirm: "dev" });
  assert.ok(!existsSync(dir));
});

test("name and lookup rules", async () => {
  freshRoot();
  await assert.rejects(createBot({ name: "Dev Bot" }), /invalid bot name/);
  await createBot({ name: "dev" });
  await assert.rejects(createBot({ name: "dev" }), /already exists/);
  assert.throws(() => readBot("missing"), /not found/);
  await assert.rejects(updateBot("missing", {}), /not found/);
  await assert.rejects(ensureInvariants("missing"), /not found/);
});
