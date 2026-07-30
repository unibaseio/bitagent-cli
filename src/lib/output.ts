/**
 * Output helpers.
 *
 * In `--json` mode stdout carries exactly one JSON document — the command's
 * result — and every human-readable line goes to stderr. That keeps
 * `bitagent ... --json | jq` usable and makes the CLI safe to drive from an
 * agent or a script.
 */

import pc from "picocolors";

let jsonMode = false;

export const setJsonMode = (enabled: boolean): void => {
  jsonMode = enabled;
};

export const isJsonMode = (): boolean => jsonMode;

const stderr = (line: string): void => {
  process.stderr.write(line + "\n");
};

/** A progress / status line. Suppressed in JSON mode? No — sent to stderr. */
export const info = (message: string): void => stderr(message);

export const step = (message: string): void => stderr(pc.dim("› ") + message);

export const success = (message: string): void => stderr(pc.green("✔ ") + message);

export const warn = (message: string): void => stderr(pc.yellow("! ") + message);

export const fail = (message: string): void => stderr(pc.red("✖ ") + message);

export const hint = (message: string): void => stderr(pc.dim("  " + message));

/** The command's result. Prints JSON in `--json` mode, otherwise `render()`. */
export function result(data: unknown, render: () => void): void {
  if (jsonMode) {
    process.stdout.write(JSON.stringify(data, jsonReplacer, 2) + "\n");
    return;
  }
  render();
}

/** BigInt is not JSON-serializable; emit it as a decimal string. */
function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

export const heading = (text: string): void => {
  process.stdout.write("\n" + pc.bold(text) + "\n");
};

/** Aligned `key: value` block. Undefined and empty values are skipped. */
export function kv(pairs: Array<[string, unknown]>, indent = "  "): void {
  const shown = pairs.filter(([, v]) => v !== undefined && v !== null && v !== "");
  const width = shown.reduce((max, [k]) => Math.max(max, k.length), 0);
  for (const [key, value] of shown) {
    process.stdout.write(`${indent}${pc.dim((key + ":").padEnd(width + 1))} ${format(value)}\n`);
  }
}

export interface Column<T> {
  header: string;
  value: (row: T) => string;
  /** Right-align numeric columns. */
  align?: "left" | "right";
  /** Truncate to this width; 0 means unlimited. */
  max?: number;
}

export function table<T>(rows: T[], columns: Array<Column<T>>): void {
  if (rows.length === 0) {
    process.stdout.write(pc.dim("  (no results)\n"));
    return;
  }

  const cells = rows.map((row) =>
    columns.map((col) => truncate(col.value(row) ?? "", col.max ?? 0)),
  );
  const widths = columns.map((col, i) =>
    Math.max(col.header.length, ...cells.map((row) => row[i]?.length ?? 0)),
  );

  const line = (values: string[], dim: boolean): void => {
    const text = values
      .map((value, i) => {
        const width = widths[i] ?? value.length;
        return columns[i]?.align === "right" ? value.padStart(width) : value.padEnd(width);
      })
      .join("  ")
      .trimEnd();
    process.stdout.write((dim ? pc.dim(text) : text) + "\n");
  };

  line(
    columns.map((c) => c.header.toUpperCase()),
    true,
  );
  for (const row of cells) line(row, false);
}

function truncate(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  if (max <= 0 || flat.length <= max) return flat;
  return flat.slice(0, Math.max(1, max - 1)) + "…";
}

function format(value: unknown): string {
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(6);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Short address form for tables: 0x1234…abcd. */
export const shortAddress = (address: string): string =>
  address && address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address || "";

export const link = (url: string): string => pc.cyan(pc.underline(url));

export { pc };
