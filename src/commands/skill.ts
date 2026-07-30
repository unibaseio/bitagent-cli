/**
 * `bitagent skill` — expose the bundled SKILL.md.
 *
 * An agent harness usually loads SKILL.md once and caches it, while the CLI is
 * upgraded independently by `npm update`. These commands let the agent detect
 * that drift and re-read the version-matched copy that ships in the package.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { CliError } from "../lib/errors.js";
import * as out from "../lib/output.js";

/** Locate SKILL.md from source (`src/commands/`) or from the bundle (`dist/bin/`). */
function skillPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "../../SKILL.md"), // src/commands/ → repo root
    resolve(here, "../../../SKILL.md"), // dist/bin/ → package root
    resolve(process.cwd(), "SKILL.md"),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new CliError(
      "SKILL.md was not found next to the installed CLI.",
      `Looked in: ${candidates.join(", ")}`,
    );
  }
  return found;
}

function installedVersion(program: Command): string {
  return program.version() ?? "0.0.0";
}

export function registerSkillCommands(program: Command): void {
  const skill = program
    .command("skill")
    .description("Print the bundled agent skill document (SKILL.md)");

  skill
    .command("path")
    .description("Print the absolute path to the bundled SKILL.md")
    .action(function (this: Command) {
      const path = skillPath();
      out.result({ path }, () => process.stdout.write(path + "\n"));
    });

  skill
    .command("print")
    .description("Print the bundled SKILL.md")
    .action(function (this: Command) {
      const path = skillPath();
      const content = readFileSync(path, "utf8");
      out.result({ path, content }, () => process.stdout.write(content));
    });

  skill
    .command("check")
    .description("Compare a loaded skill copy against the installed CLI version")
    .requiredOption("--against <version>", "The bitagentCliVersion your loaded copy declares")
    .action(function (this: Command) {
      const { against } = this.opts<{ against: string }>();
      const installed = installedVersion(program);
      const upToDate = against.trim() === installed;

      out.result(
        {
          installed,
          against: against.trim(),
          upToDate,
          action: upToDate ? "none" : "reload",
          path: skillPath(),
        },
        () => {
          out.kv([
            ["installed cli", installed],
            ["loaded skill", against.trim()],
            ["up to date", upToDate],
          ]);
          if (!upToDate) {
            out.warn("Your loaded skill copy is out of step with the installed CLI.");
            out.hint("Re-read it with `bitagent skill print`.");
          }
        },
      );
    });
}
