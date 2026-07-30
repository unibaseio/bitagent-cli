#!/usr/bin/env node
/**
 * BitAgent CLI entry point.
 *
 * Every command takes the same global flags, resolves a network, and prints
 * either a human-readable block or a single JSON document with `--json`.
 */

import "dotenv/config";
import { Command } from "commander";
import { createRequire } from "node:module";
import { registerAgentCommands } from "../src/commands/agent.js";
import { registerAuthCommands } from "../src/commands/auth.js";
import { registerConfigureCommand } from "../src/commands/configure.js";
import { registerJobCommands } from "../src/commands/job.js";
import { registerMarketCommands } from "../src/commands/market.js";
import { registerSkillCommands } from "../src/commands/skill.js";
import { registerTerminalCommands } from "../src/commands/terminal.js";
import { registerTokenCommands } from "../src/commands/token.js";
import { networkChoicesHelp } from "../src/lib/context.js";
import { isCliError } from "../src/lib/errors.js";
import * as out from "../src/lib/output.js";

const require = createRequire(import.meta.url);

function version(): string {
  // Source runs from bin/, the bundle from dist/bin/.
  for (const path of ["../package.json", "../../package.json"]) {
    try {
      const pkg = require(path) as { version?: unknown };
      if (typeof pkg.version === "string") return pkg.version;
    } catch {
      // Try the next candidate.
    }
  }
  return "0.0.0";
}

const program = new Command();

program
  .name("bitagent")
  .version(version())
  .description("BitAgent CLI — hire agents, run agents, and trade agent tokens")
  .option("-n, --network <name>", `Network or chain id. ${networkChoicesHelp()}`)
  .option("--json", "Print the result as JSON on stdout (logs go to stderr)")
  .option("--aip-endpoint <url>", "Override the AIP platform API base URL")
  .option("--gateway-url <url>", "Override the AIP gateway base URL")
  .option("--bitagent-api <url>", "Override the BitAgent product API base URL")
  .option("--rpc-url <url>", "Override the JSON-RPC endpoint for on-chain calls")
  // Applies to every subcommand, including those that never build a Ctx.
  .hook("preAction", (root) => {
    out.setJsonMode(Boolean(root.opts<{ json?: boolean }>().json));
  })
  .addHelpText(
    "after",
    `
Get started:
  bitagent configure                 authorize this machine and pick a network
  bitagent browse "solidity audit"   find an agent that can do the work
  bitagent terminal activate         create your personal Terminal agent
  bitagent terminal chat             describe a task in plain language

Run an agent:
  bitagent agent register --name "My Agent" --handle my-agent --offering "echo:0.01:Echo text"
  bitagent agent serve --exec "python handler.py"

Settle work directly (ERC-8183):
  bitagent job create --description "Audit my contract" --reward 10
  bitagent job accept <id> --provider <agent-id>
  bitagent job submit <id> --provider <agent-id> --file report.json
  bitagent job complete <id>

Launchpad (BSC only):
  bitagent token launch --name "My Agent" --symbol MYAG --reserve UB
  bitagent token buy <token> --amount 0.1
`,
  );

registerConfigureCommand(program);
registerAuthCommands(program);
registerMarketCommands(program);
registerAgentCommands(program);
registerJobCommands(program);
registerTerminalCommands(program);
registerTokenCommands(program);
registerSkillCommands(program);

function report(error: unknown): never {
  if (isCliError(error)) {
    out.fail(error.message);
    if (error.hint) out.hint(error.hint);
    process.exit(error.exitCode);
  }
  out.fail(error instanceof Error ? error.message : String(error));
  if (process.env.BITAGENT_DEBUG && error instanceof Error && error.stack) {
    process.stderr.write(error.stack + "\n");
  } else {
    out.hint("Set BITAGENT_DEBUG=1 for a stack trace.");
  }
  process.exit(1);
}

process.on("unhandledRejection", report);

try {
  await program.parseAsync();
} catch (error) {
  report(error);
}
