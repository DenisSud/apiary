import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAttach, runClient } from "./launcher.ts";
import { listBots } from "./registry.ts";

const USAGE = `usage:
  pi-bot attach <bot> [--new]   attach to a bot (starts its server if needed)
  pi-bot resolve <bot> [--new]  ensure the server and resolve the session
  pi-bot list                   list bots
  pi-bot new <name>             scaffold a new bot
  pi-bot <bot> [--new]          same as attach
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

function commandNew(args: string[]): number {
  const script = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "bin", "pi-bot-new");
  const result = spawnSync(script, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

async function main(args: string[]): Promise<number> {
  const first = args[0];
  if (first === undefined) {
    process.stderr.write(USAGE);
    return 2;
  }
  switch (first) {
    case "list": {
      for (const bot of listBots()) console.log(bot.name);
      return 0;
    }
    case "new":
      return commandNew(args.slice(1));
    case "attach":
      return commandAttach(args.slice(1));
    case "resolve":
      return commandResolve(args.slice(1));
    default:
      if (first.startsWith("-")) {
        process.stderr.write(USAGE);
        return 2;
      }
      return commandAttach(args); // sugar: pi-bot <bot>
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`pi-bot: ${message}\n`);
  process.exitCode = 1;
}
