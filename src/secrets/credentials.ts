import { BridgeError, type BridgeErrorCode } from "../domain/errors.js";

export const MAX_CREDENTIAL_ACCOUNT_BYTES = 512;
export const MAX_CREDENTIAL_TOKEN_BYTES = 16 * 1024;

export interface CredentialStore {
  set(account: string, token: string): Promise<void>;
  get(account: string): Promise<string>;
  delete(account: string): Promise<void>;
  listAccounts(): Promise<string[]>;
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return (
      codePoint !== undefined && (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
    );
  });
}

export function validateCredentialAccount(
  value: unknown,
  code: BridgeErrorCode = "INVALID_ARGUMENT",
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    hasControlCharacters(value) ||
    Buffer.byteLength(value, "utf8") > MAX_CREDENTIAL_ACCOUNT_BYTES
  ) {
    throw new BridgeError(
      code,
      "Invalid credential account",
      "Use a nonempty credential account name without control characters.",
    );
  }
  return value;
}

export function validateCredentialToken(
  value: unknown,
  code: BridgeErrorCode = "INVALID_ARGUMENT",
): string {
  if (typeof value !== "string") {
    throw new BridgeError(
      code,
      "Invalid credential token",
      "Supply the bot token as a nonempty string.",
    );
  }
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes === 0 || bytes > MAX_CREDENTIAL_TOKEN_BYTES) {
    throw new BridgeError(
      code,
      "Invalid credential token size",
      `Supply a token between 1 and ${MAX_CREDENTIAL_TOKEN_BYTES} UTF-8 bytes.`,
    );
  }
  return value;
}

export function sortCredentialAccounts(accounts: readonly string[]): string[] {
  return [...accounts].sort((left, right) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
  );
}
