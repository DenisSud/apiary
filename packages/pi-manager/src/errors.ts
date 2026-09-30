export type BotErrorCode = "invalid" | "not_found" | "exists" | "conflict";

/** Failure modes adapters (HTTP, CLI) map to statuses and exit codes. */
export class BotError extends Error {
  readonly code: BotErrorCode;

  constructor(code: BotErrorCode, message: string) {
    super(message);
    this.name = "BotError";
    this.code = code;
  }
}
