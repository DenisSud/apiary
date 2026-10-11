import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { archiveBot, createBot, deleteBot, readBot, unarchiveBot } from "@apiary/pi-manager";
import { resolveAttach, runClient, stopServer } from "./launcher.ts";
import { lockPath, logPath, serverDir } from "./paths.ts";
import { clearRoute, listBots } from "./registry.ts";
import { clearSession } from "./sessions.ts";

const BIN_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "bin");
// The fork's /bot and /new call back into this CLI; tell it where we are.
process.env.PI_BOT_BIN ??= join(BIN_DIR, "apiary");

const USAGE = `usage:
  apiary attach <bot> [--new]             attach to a bot (starts its server if needed)
  apiary message <bot> <text...> [--new]  send a prompt and print the reply
  apiary compact <bot> [--new]            compact the bot's session
  apiary stop <bot>                       stop the bot's server
  apiary resolve <bot> [--new]            ensure the server and resolve the session
  apiary list [--json] [--all]            list bots (JSON for the TUI picker)
  apiary show <bot>                       print a bot's config as JSON
  apiary new <name>                       scaffold a new bot (name only)
  apiary archive <bot>                    stop the server and archive the bot
  apiary unarchive <bot>                  make an archived bot usable again
  apiary rm <bot> --yes                   delete a bot and its dir
  apiary <bot> [--new]                    same as attach
`;

function parseBotArgs(args: string[]): { name: string; fresh: boolean } {
  let name: string | undefined;
  let fresh = false;
  for (const arg of args) {
    if (arg === "--new") fresh = true;
    else if (name === undefined) name = arg;
    else throw new Error(`unexpected argument '${arg}'`);
  }
  if (name === undefined) throw new Error("missing bot name");
  return { name, fresh };
}

async function commandAttach(args: string[]): Promise<number> {
  const { name, fresh } = parseBotArgs(args);
  const target = await resolveAttach(name, { new: fresh });
  return runClient(target);
}

async function commandResolve(args: string[]): Promise<number> {
  const json = args.includes("--json");
  const { name, fresh } = parseBotArgs(args.filter((arg) => arg !== "--json"));
  const target = await resolveAttach(name, { new: fresh });
  if (json) {
    console.log(
      JSON.stringify({
        bot: target.bot,
        dir: target.dir,
        serverId: target.serverId,
        socketPath: target.socketPath,
        sessionId: target.sessionId,
      }),
    );
  } else {
    console.log(`${target.bot}\t${target.sessionId}\t${target.socketPath}`);
  }
  return 0;
}

async function commandNew(args: string[]): Promise<number> {
  const [name, ...rest] = args;
  if (name === undefined) throw new Error("usage: apiary new <name>");
  if (rest.length > 0) throw new Error(`unexpected argument '${rest[0]}': create takes a name only`);
  const bot = await createBot({ name });
  console.log(`created ${bot.dir}`);
  return 0;
}

function commandShow(args: string[]): number {
  const name = args[0];
  if (name === undefined) throw new Error("missing bot name");
  console.log(JSON.stringify(readBot(name), null, 2));
  return 0;
}

async function commandArchive(args: string[]): Promise<number> {
  const name = args[0];
  if (name === undefined) throw new Error("missing bot name");
  readBot(name);
  const result = await stopServer(name);
  archiveBot(name);
  console.log(result.stopped ? `archived ${name} (stopped pid ${result.pid})` : `archived ${name}`);
  return 0;
}

function commandUnarchive(args: string[]): number {
  const name = args[0];
  if (name === undefined) throw new Error("missing bot name");
  unarchiveBot(name);
  console.log(`unarchived ${name}`);
  return 0;
}

async function commandRemove(args: string[]): Promise<number> {
  const name = args[0];
  if (name === undefined) throw new Error("missing bot name");
  if (!args.includes("--yes")) throw new Error(`refusing to delete '${name}': pass --yes to confirm`);
  readBot(name);
  await stopServer(name);
  deleteBot(name, { confirm: name });
  clearRoute(name);
  clearSession(name);
  rmSync(lockPath(name), { force: true });
  rmSync(logPath(name), { force: true });
  rmSync(serverDir(name), { recursive: true, force: true });
  console.log(`deleted ${name}`);
  return 0;
}

async function commandCompact(args: string[]): Promise<number> {
  const { name, fresh } = parseBotArgs(args);
  const target = await resolveAttach(name, { new: fresh });
  return runClient(target, ["--compact"]);
}

async function commandMessage(args: string[]): Promise<number> {
  const fresh = args.includes("--new");
  const rest = args.filter((arg) => arg !== "--new");
  const name = rest[0];
  if (name === undefined) throw new Error("missing bot name");
  const text = rest.slice(1).join(" ");
  if (text.length === 0) throw new Error("missing message text");
  const target = await resolveAttach(name, { new: fresh });
  // "--" forces the text to be read as the prompt even if it starts with "-".
  return runClient(target, ["--", text]);
}

async function commandStop(args: string[]): Promise<number> {
  const { name } = parseBotArgs(args);
  const result = await stopServer(name);
  console.log(result.stopped ? `stopped ${name} (pid ${result.pid})` : `${name} not running`);
  return 0;
}

async function main(args: string[]): Promise<number> {
  const first = args[0];
  if (first === undefined) {
    process.stderr.write(USAGE);
    return 2;
  }
  switch (first) {
    case "list": {
      const bots = listBots({ includeArchived: args.includes("--all") });
      if (args.includes("--json")) console.log(JSON.stringify(bots));
      else for (const bot of bots) console.log(bot.archived ? `${bot.name}\tarchived` : bot.name);
      return 0;
    }
    case "new":
      return commandNew(args.slice(1));
    case "show":
      return commandShow(args.slice(1));
    case "archive":
      return commandArchive(args.slice(1));
    case "unarchive":
      return commandUnarchive(args.slice(1));
    case "rm":
      return commandRemove(args.slice(1));
    case "attach":
      return commandAttach(args.slice(1));
    case "message":
      return commandMessage(args.slice(1));
    case "compact":
      return commandCompact(args.slice(1));
    case "stop":
      return commandStop(args.slice(1));
    case "resolve":
      return commandResolve(args.slice(1));
    default:
      if (first.startsWith("-")) {
        process.stderr.write(USAGE);
        return 2;
      }
      return commandAttach(args); // sugar: apiary <bot>
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`apiary: ${message}\n`);
  process.exitCode = 1;
}
