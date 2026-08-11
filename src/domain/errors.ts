export type BridgeErrorCode =
  | "INVALID_ARGUMENT"
  | "NOT_FOUND"
  | "CONFLICT"
  | "UNAUTHORIZED"
  | "CONFIGURATION"
  | "RUNTIME"
  | "TIMEOUT";

const EXIT_CODES: Record<BridgeErrorCode, number> = {
  INVALID_ARGUMENT: 2,
  NOT_FOUND: 3,
  CONFLICT: 4,
  UNAUTHORIZED: 5,
  CONFIGURATION: 6,
  RUNTIME: 7,
  TIMEOUT: 8,
};

export class BridgeError extends Error {
  constructor(
    readonly code: BridgeErrorCode,
    message: string,
    readonly remediation?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "BridgeError";
  }
}

export function exitCodeFor(error: unknown): number {
  return error instanceof BridgeError ? EXIT_CODES[error.code] : 7;
}
