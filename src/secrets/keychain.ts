import {
  type ChildProcessWithoutNullStreams,
  spawn as nodeSpawn,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { BridgeError } from "../domain/errors.js";
import type { CredentialStore } from "./credentials.js";

export const DEFAULT_KEYCHAIN_SERVICE = "com.openai.codex-discord-bridge";
export const KEYCHAIN_NOT_FOUND_EXIT_CODE = 44;
export const MAX_KEYCHAIN_TOKEN_BYTES = 16 * 1024;
export const MAX_KEYCHAIN_HELPER_STDOUT_BYTES = 256 * 1024;
export const MAX_KEYCHAIN_HELPER_STDERR_BYTES = 16 * 1024;
export const DEFAULT_KEYCHAIN_HELPER_TIMEOUT_MS = 5_000;
export const DEFAULT_KEYCHAIN_KILL_GRACE_MS = 250;

const MAX_KEYCHAIN_NAME_BYTES = 512;
const MAX_CONFIGURED_STREAM_BYTES = 8 * 1024 * 1024;
const MAX_CONFIGURED_TIMEOUT_MS = 60_000;
const MAX_CONFIGURED_KILL_GRACE_MS = 5_000;
const DEFAULT_HELPER_PATH = fileURLToPath(new URL("../native/keychain-helper", import.meta.url));
const HELPER_REMEDIATION =
  "Run `npm run native:build`, then verify the packaged Keychain helper is executable.";

export type KeychainSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

export interface KeychainStoreOptions {
  readonly helperPath?: string;
  readonly service?: string;
  readonly spawn?: KeychainSpawn;
  readonly timeoutMs?: number;
  readonly killGraceMs?: number;
  readonly maxStdoutBytes?: number;
  readonly maxStderrBytes?: number;
}

interface HelperResult {
  readonly stdout: Buffer;
  readonly stderrBytes: number;
}

type KeychainCommand = "set" | "get" | "delete" | "list";

function configurationError(message: string, remediation = HELPER_REMEDIATION): BridgeError {
  return new BridgeError("CONFIGURATION", message, remediation);
}

function validateConfiguredInteger(value: number, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw configurationError(
      `Invalid Keychain helper ${label}`,
      `Set ${label} to a positive bounded integer and retry.`,
    );
  }
  return value;
}

function validateName(
  value: unknown,
  label: "service" | "account",
  code: "CONFIGURATION" | "INVALID_ARGUMENT",
): string {
  const containsControlCharacter =
    typeof value === "string" &&
    Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0);
      return (
        codePoint !== undefined && (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
      );
    });
  const invalid =
    typeof value !== "string" ||
    value.length === 0 ||
    containsControlCharacter ||
    Buffer.byteLength(value, "utf8") > MAX_KEYCHAIN_NAME_BYTES;
  if (invalid) {
    const remediation =
      code === "CONFIGURATION"
        ? "Configure a nonempty Keychain service name without control characters."
        : "Use a nonempty Keychain account name without control characters.";
    throw new BridgeError(code, `Invalid Keychain ${label}`, remediation);
  }
  return value;
}

function validateToken(token: unknown): Buffer {
  if (typeof token !== "string") {
    throw new BridgeError(
      "INVALID_ARGUMENT",
      "Invalid Keychain token",
      "Supply the bot token as a nonempty string.",
    );
  }
  const bytes = Buffer.from(token, "utf8");
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_KEYCHAIN_TOKEN_BYTES) {
    throw new BridgeError(
      "INVALID_ARGUMENT",
      "Invalid Keychain token size",
      `Supply a token between 1 and ${MAX_KEYCHAIN_TOKEN_BYTES} UTF-8 bytes.`,
    );
  }
  return bytes;
}

function decodeUtf8(bytes: Buffer, outputLabel: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw configurationError(`Keychain helper returned invalid ${outputLabel}`);
  }
}

export class KeychainStore implements CredentialStore {
  readonly #helperPath: string;
  readonly #service: string;
  readonly #spawn: KeychainSpawn;
  readonly #timeoutMs: number;
  readonly #killGraceMs: number;
  readonly #maxStdoutBytes: number;
  readonly #maxStderrBytes: number;

  constructor(options: KeychainStoreOptions = {}) {
    if (typeof options !== "object" || options === null || Array.isArray(options)) {
      throw configurationError(
        "Invalid Keychain configuration",
        "Configure the Keychain store with an options object.",
      );
    }
    const helperPath = options.helperPath ?? DEFAULT_HELPER_PATH;
    if (typeof helperPath !== "string" || !isAbsolute(helperPath) || helperPath.includes("\0")) {
      throw configurationError(
        "Invalid Keychain helper path",
        "Configure an absolute path to the packaged Keychain helper.",
      );
    }

    this.#helperPath = helperPath;
    this.#service = validateName(
      options.service ?? DEFAULT_KEYCHAIN_SERVICE,
      "service",
      "CONFIGURATION",
    );
    this.#spawn = options.spawn ?? (nodeSpawn as KeychainSpawn);
    if (typeof this.#spawn !== "function") {
      throw configurationError("Invalid Keychain spawn implementation");
    }
    this.#timeoutMs = validateConfiguredInteger(
      options.timeoutMs ?? DEFAULT_KEYCHAIN_HELPER_TIMEOUT_MS,
      "timeout",
      MAX_CONFIGURED_TIMEOUT_MS,
    );
    this.#killGraceMs = validateConfiguredInteger(
      options.killGraceMs ?? DEFAULT_KEYCHAIN_KILL_GRACE_MS,
      "kill grace",
      MAX_CONFIGURED_KILL_GRACE_MS,
    );
    this.#maxStdoutBytes = validateConfiguredInteger(
      options.maxStdoutBytes ?? MAX_KEYCHAIN_HELPER_STDOUT_BYTES,
      "stdout limit",
      MAX_CONFIGURED_STREAM_BYTES,
    );
    this.#maxStderrBytes = validateConfiguredInteger(
      options.maxStderrBytes ?? MAX_KEYCHAIN_HELPER_STDERR_BYTES,
      "stderr limit",
      MAX_CONFIGURED_STREAM_BYTES,
    );
  }

  async set(account: string, token: string): Promise<void> {
    const validatedAccount = validateName(account, "account", "INVALID_ARGUMENT");
    const input = validateToken(token);
    const result = await this.#execute("set", [validatedAccount], input);
    this.#requireSilentSuccess(result, "set");
  }

  async get(account: string): Promise<string> {
    const validatedAccount = validateName(account, "account", "INVALID_ARGUMENT");
    const result = await this.#execute("get", [validatedAccount]);
    if (result.stderrBytes !== 0) {
      throw configurationError("Keychain helper emitted unexpected diagnostics during get");
    }
    if (result.stdout.byteLength === 0 || result.stdout.byteLength > MAX_KEYCHAIN_TOKEN_BYTES) {
      throw configurationError("Keychain helper returned an invalid token size");
    }
    return decodeUtf8(result.stdout, "token bytes");
  }

  async delete(account: string): Promise<void> {
    const validatedAccount = validateName(account, "account", "INVALID_ARGUMENT");
    const result = await this.#execute("delete", [validatedAccount]);
    this.#requireSilentSuccess(result, "delete");
  }

  async listAccounts(): Promise<string[]> {
    const result = await this.#execute("list", []);
    if (result.stderrBytes !== 0) {
      throw configurationError("Keychain helper emitted unexpected diagnostics during list");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(decodeUtf8(result.stdout, "account list"));
    } catch (error) {
      if (error instanceof BridgeError) {
        throw error;
      }
      throw configurationError("Keychain helper returned an invalid account list");
    }
    if (!Array.isArray(parsed)) {
      throw configurationError("Keychain helper returned an invalid account list");
    }

    const accounts: string[] = [];
    for (const account of parsed) {
      try {
        accounts.push(validateName(account, "account", "CONFIGURATION"));
      } catch {
        throw configurationError("Keychain helper returned an invalid account list");
      }
    }

    const sorted = [...accounts].sort((left, right) =>
      Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
    );
    if (
      new Set(accounts).size !== accounts.length ||
      accounts.some((account, index) => account !== sorted[index])
    ) {
      throw configurationError("Keychain helper returned a non-unique or unsorted account list");
    }
    return accounts;
  }

  #requireSilentSuccess(result: HelperResult, operation: "set" | "delete"): void {
    if (result.stdout.byteLength !== 0 || result.stderrBytes !== 0) {
      throw configurationError(`Keychain helper emitted unexpected output during ${operation}`);
    }
  }

  #execute(
    command: KeychainCommand,
    commandArguments: readonly string[],
    input?: Buffer,
  ): Promise<HelperResult> {
    const args = [command, this.#service, ...commandArguments];
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.#spawn(this.#helperPath, args, {
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      return Promise.reject(configurationError("Unable to start the Keychain helper"));
    }

    return new Promise<HelperResult>((resolve, reject) => {
      const stdoutChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let terminalError: BridgeError | undefined;
      let settled = false;
      let operationTimer: NodeJS.Timeout | undefined;
      let killGraceTimer: NodeJS.Timeout | undefined;

      const cleanup = (): void => {
        if (operationTimer !== undefined) {
          clearTimeout(operationTimer);
        }
        if (killGraceTimer !== undefined) {
          clearTimeout(killGraceTimer);
        }
        child.removeListener("error", onSpawnError);
        child.removeListener("close", onClose);
        child.stdin.removeListener("error", onStdinError);
        child.stdout.removeListener("data", onStdout);
        child.stderr.removeListener("data", onStderr);
      };

      const detachChild = (): void => {
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        try {
          child.unref();
        } catch {
          // A custom child may not have an active process handle to unref.
        }
      };

      const guardLateChildErrors = (): void => {
        const ignoreLateChildError = (): void => undefined;
        const removeLateErrorGuard = (): void => {
          child.removeListener("error", ignoreLateChildError);
        };
        child.on("error", ignoreLateChildError);
        child.once("close", removeLateErrorGuard);
      };

      const settleReject = (error: BridgeError): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error);
      };

      const failAndKill = (error: BridgeError): void => {
        if (terminalError !== undefined || settled) {
          return;
        }
        terminalError = error;
        try {
          child.kill("SIGKILL");
        } catch {
          // Grace expiry still guarantees bounded settlement.
        }
        if (settled) {
          return;
        }
        killGraceTimer = setTimeout(() => {
          const pendingError = terminalError;
          if (pendingError === undefined || settled) {
            return;
          }
          detachChild();
          settleReject(pendingError);
          guardLateChildErrors();
        }, this.#killGraceMs);
      };

      const onStdout = (chunk: Buffer | string): void => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stdoutBytes += bytes.byteLength;
        if (stdoutBytes > this.#maxStdoutBytes) {
          failAndKill(configurationError("Keychain helper stdout exceeded its safety limit"));
          return;
        }
        stdoutChunks.push(bytes);
      };

      const onStderr = (chunk: Buffer | string): void => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stderrBytes += bytes.byteLength;
        if (stderrBytes > this.#maxStderrBytes) {
          failAndKill(configurationError("Keychain helper stderr exceeded its safety limit"));
        }
      };

      const onSpawnError = (): void => {
        if (terminalError !== undefined) {
          return;
        }
        settleReject(configurationError("Unable to start the Keychain helper"));
      };

      const onStdinError = (): void => {
        failAndKill(configurationError("Unable to send input to the Keychain helper"));
      };

      const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (settled) {
          return;
        }
        if (terminalError !== undefined) {
          settleReject(terminalError);
          return;
        }
        if (signal !== null) {
          settleReject(configurationError(`Keychain helper terminated by signal ${signal}`));
          return;
        }
        if (code === KEYCHAIN_NOT_FOUND_EXIT_CODE) {
          settleReject(
            new BridgeError(
              "NOT_FOUND",
              "Keychain entry was not found",
              "Register the bot credential and retry.",
            ),
          );
          return;
        }
        if (code !== 0) {
          const exitMetadata =
            code === null ? "without an exit status" : `with exit status ${code}`;
          settleReject(
            configurationError(
              `Keychain helper failed ${exitMetadata}; stderr bytes: ${stderrBytes}`,
            ),
          );
          return;
        }

        settled = true;
        cleanup();
        resolve({
          stdout: Buffer.concat(stdoutChunks, stdoutBytes),
          stderrBytes,
        });
      };

      child.stdout.on("data", onStdout);
      child.stderr.on("data", onStderr);
      child.once("error", onSpawnError);
      child.once("close", onClose);
      child.stdin.once("error", onStdinError);

      operationTimer = setTimeout(() => {
        failAndKill(
          new BridgeError(
            "TIMEOUT",
            "Keychain helper timed out",
            "Retry after confirming the logged-in macOS keychain is available.",
          ),
        );
      }, this.#timeoutMs);
      operationTimer.unref();

      if (input === undefined) {
        child.stdin.end();
      } else {
        child.stdin.end(input);
      }
    });
  }
}
