/** Interactive prompts. Every one of them refuses to run without a TTY. */

import * as readline from "node:readline/promises";
import { CliError } from "./errors.js";

const requireTty = (what: string): void => {
  if (!process.stdin.isTTY) {
    throw new CliError(
      `${what} requires an interactive terminal.`,
      "Pass the value as a flag, or set the matching environment variable.",
    );
  }
};

export async function ask(question: string, fallback = ""): Promise<string> {
  requireTty("This prompt");
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(fallback ? `${question} [${fallback}] ` : `${question} `);
    return answer.trim() || fallback;
  } finally {
    rl.close();
  }
}

export async function confirm(question: string, fallback = false): Promise<boolean> {
  const answer = await ask(`${question} ${fallback ? "[Y/n]" : "[y/N]"}`);
  if (!answer) return fallback;
  return /^y(es)?$/i.test(answer.trim());
}

/** Read a line without echoing it — for private keys and tokens. */
export async function askSecret(question: string): Promise<string> {
  requireTty("This prompt");
  process.stderr.write(question + " ");

  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;
  stdin.setRawMode(true);
  stdin.resume();

  return await new Promise<string>((resolve, reject) => {
    let value = "";
    const onData = (chunk: Buffer): void => {
      for (const byte of chunk) {
        // Ctrl-C
        if (byte === 3) {
          cleanup();
          reject(new CliError("Aborted."));
          return;
        }
        // Enter (CR or LF)
        if (byte === 13 || byte === 10) {
          cleanup();
          process.stderr.write("\n");
          resolve(value.trim());
          return;
        }
        // Backspace / Delete
        if (byte === 8 || byte === 127) {
          value = value.slice(0, -1);
          continue;
        }
        if (byte >= 32) value += String.fromCharCode(byte);
      }
    };

    const cleanup = (): void => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(wasRaw ?? false);
      stdin.pause();
    };

    stdin.on("data", onData);
  });
}

/** Numbered single-choice menu. Returns the chosen option's value. */
export async function select<T>(
  title: string,
  options: Array<{ label: string; value: T }>,
  defaultIndex = 0,
): Promise<T> {
  requireTty("This prompt");
  process.stderr.write(title + "\n");
  options.forEach((option, i) => {
    process.stderr.write(`  ${i + 1}) ${option.label}\n`);
  });

  for (;;) {
    const answer = await ask("Choice", String(defaultIndex + 1));
    const index = Number(answer) - 1;
    const chosen = options[index];
    if (chosen) return chosen.value;
    process.stderr.write("  Please enter a number from the list.\n");
  }
}
