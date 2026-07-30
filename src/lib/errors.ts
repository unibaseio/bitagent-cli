/** A user-facing failure: printed without a stack trace, exits non-zero. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = "CliError";
  }
}

/** An HTTP failure carrying the status and the server's message. */
export class ApiError extends CliError {
  constructor(
    readonly status: number,
    readonly detail: string,
    readonly url: string,
    hint?: string,
  ) {
    super(`HTTP ${status} from ${url}: ${detail}`, hint);
    this.name = "ApiError";
  }
}

export const isCliError = (e: unknown): e is CliError => e instanceof CliError;

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
