import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import {
  chmod,
  type FileHandle,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { BridgeError } from "../domain/errors.js";
import {
  type CredentialStore,
  sortCredentialAccounts,
  validateCredentialAccount,
  validateCredentialToken,
} from "./credentials.js";

const CREDENTIAL_DIRECTORY_MODE = 0o700;
const CREDENTIAL_FILE_MODE = 0o600;
const CREDENTIAL_DIRECTORY_NAME = "credentials";
const CREDENTIAL_RECORD_MAX_BYTES = 128 * 1024;
const RECORD_FILE_NAME = /^[a-f0-9]{64}\.json$/u;
const READ_FLAGS =
  fsConstants.O_RDONLY |
  fsConstants.O_NONBLOCK |
  (typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0);

interface CredentialRecord {
  readonly account: string;
  readonly token: string;
}

export interface FileCredentialStoreOptions {
  readonly stateRoot: string;
}

function configurationError(message: string, remediation: string): BridgeError {
  return new BridgeError("CONFIGURATION", message, remediation);
}

function runtimeError(operation: string, cause: unknown): BridgeError {
  return new BridgeError(
    "RUNTIME",
    `Unable to ${operation} local credential storage.`,
    "Check that the bridge state directory is writable by the bridge service user.",
    { cause },
  );
}

function notFoundError(): BridgeError {
  return new BridgeError("NOT_FOUND", "Credential account was not found.");
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function accountDigest(account: string): string {
  return createHash("sha256").update(account, "utf8").digest("hex");
}

function recordFileName(account: string): string {
  return `${accountDigest(account)}.json`;
}

function validateStateRoot(value: unknown): string {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) {
    throw configurationError(
      "Invalid local credential state root.",
      "Configure an absolute bridge state-root path without NUL bytes.",
    );
  }
  return value;
}

function validateOptions(value: unknown): FileCredentialStoreOptions {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw configurationError(
      "Invalid local credential storage configuration.",
      "Configure the local credential store with a state-root object.",
    );
  }
  const options = value as Partial<FileCredentialStoreOptions>;
  return { stateRoot: validateStateRoot(options.stateRoot) };
}

function validateRecord(value: unknown): CredentialRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw configurationError(
      "Credential record is malformed.",
      "Replace the malformed credential record before retrying.",
    );
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== "account" || keys[1] !== "token") {
    throw configurationError(
      "Credential record is malformed.",
      "Replace the malformed credential record before retrying.",
    );
  }
  return {
    account: validateCredentialAccount(record.account, "CONFIGURATION"),
    token: validateCredentialToken(record.token, "CONFIGURATION"),
  };
}

function decodeRecord(value: Buffer): CredentialRecord {
  let contents: string;
  try {
    contents = new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch (_error) {
    throw configurationError(
      "Credential record is not valid UTF-8.",
      "Replace the malformed credential record before retrying.",
    );
  }
  try {
    return validateRecord(JSON.parse(contents));
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw configurationError(
      "Credential record is malformed.",
      "Replace the malformed credential record before retrying.",
    );
  }
}

export class FileCredentialStore implements CredentialStore {
  readonly #credentialsDirectory: string;

  constructor(options: FileCredentialStoreOptions) {
    const configured = validateOptions(options);
    this.#credentialsDirectory = join(configured.stateRoot, CREDENTIAL_DIRECTORY_NAME);
  }

  async set(account: string, token: string): Promise<void> {
    const validatedAccount = validateCredentialAccount(account);
    const validatedToken = validateCredentialToken(token);
    await this.#ensureDirectory(true);
    const targetPath = this.#recordPath(validatedAccount);
    const contents = Buffer.from(
      `${JSON.stringify({ account: validatedAccount, token: validatedToken })}\n`,
      "utf8",
    );
    await this.#writeAtomically(targetPath, contents);
  }

  async get(account: string): Promise<string> {
    const validatedAccount = validateCredentialAccount(account);
    if (!(await this.#ensureDirectory(false))) throw notFoundError();
    const record = await this.#readRecord(this.#recordPath(validatedAccount));
    if (record === undefined) throw notFoundError();
    if (record.account !== validatedAccount) {
      throw configurationError(
        "Credential record account does not match its requested account.",
        "Replace the mismatched credential record before retrying.",
      );
    }
    return record.token;
  }

  async delete(account: string): Promise<void> {
    const validatedAccount = validateCredentialAccount(account);
    if (!(await this.#ensureDirectory(false))) throw notFoundError();
    const targetPath = this.#recordPath(validatedAccount);
    const record = await this.#readRecord(targetPath);
    if (record === undefined) throw notFoundError();
    if (record.account !== validatedAccount) {
      throw configurationError(
        "Credential record account does not match its requested account.",
        "Replace the mismatched credential record before retrying.",
      );
    }
    try {
      await unlink(targetPath);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) throw notFoundError();
      throw runtimeError("delete", error);
    }
  }

  async listAccounts(): Promise<string[]> {
    if (!(await this.#ensureDirectory(false))) return [];
    const entries = await this.#readDirectoryEntries();

    const accounts: string[] = [];
    for (const entry of entries) {
      if (!RECORD_FILE_NAME.test(entry.name)) continue;
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw configurationError(
          "Credential record must be a regular file, not a symbolic link.",
          "Replace the unsafe credential record before retrying.",
        );
      }
      const record = await this.#readRecord(join(this.#credentialsDirectory, entry.name));
      if (record === undefined || recordFileName(record.account) !== entry.name) {
        throw configurationError(
          "Credential record does not match its storage path.",
          "Replace the mismatched credential record before retrying.",
        );
      }
      accounts.push(record.account);
    }
    return sortCredentialAccounts(accounts);
  }

  #recordPath(account: string): string {
    return join(this.#credentialsDirectory, recordFileName(account));
  }

  async #ensureDirectory(create: boolean): Promise<boolean> {
    if (create) {
      try {
        await mkdir(this.#credentialsDirectory, {
          mode: CREDENTIAL_DIRECTORY_MODE,
          recursive: true,
        });
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) throw runtimeError("create", error);
      }
    }

    let target: Stats;
    try {
      target = await lstat(this.#credentialsDirectory);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return false;
      throw runtimeError("inspect", error);
    }
    if (target.isSymbolicLink()) {
      throw configurationError(
        "Credential directory must not be a symbolic link.",
        "Replace the symbolic link with a private bridge-owned directory.",
      );
    }
    if (!target.isDirectory()) {
      throw configurationError(
        "Credential directory must be a directory.",
        "Move the non-directory entry and retry.",
      );
    }
    try {
      await chmod(this.#credentialsDirectory, CREDENTIAL_DIRECTORY_MODE);
    } catch (error) {
      throw runtimeError("secure", error);
    }
    return true;
  }

  async #readRecord(path: string): Promise<CredentialRecord | undefined> {
    let beforeOpen: Stats;
    try {
      beforeOpen = await lstat(path);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return undefined;
      throw runtimeError("inspect", error);
    }
    if (beforeOpen.isSymbolicLink()) {
      throw configurationError(
        "Credential record must not be a symbolic link.",
        "Replace the symbolic link with a private credential record.",
      );
    }
    this.#validateCredentialFile(beforeOpen);

    let handle: FileHandle;
    try {
      handle = await open(path, READ_FLAGS);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return undefined;
      if (isNodeError(error, "ELOOP")) {
        throw configurationError(
          "Credential record must not be a symbolic link.",
          "Replace the symbolic link with a private credential record.",
        );
      }
      throw runtimeError("open", error);
    }

    let contents = Buffer.alloc(0);
    let primary: unknown;
    try {
      this.#validateCredentialFile(await handle.stat());
      contents = await handle.readFile();
    } catch (error) {
      primary = error;
    }
    try {
      await handle.close();
    } catch (error) {
      if (primary === undefined) primary = runtimeError("close", error);
    }
    if (primary !== undefined) {
      if (primary instanceof BridgeError) throw primary;
      throw runtimeError("read", primary);
    }
    return decodeRecord(contents);
  }

  #validateCredentialFile(target: Stats): void {
    if (!target.isFile()) {
      throw configurationError(
        "Credential record must be a regular file.",
        "Replace the unsafe credential record before retrying.",
      );
    }
    if ((target.mode & 0o777) !== CREDENTIAL_FILE_MODE) {
      throw configurationError(
        "Credential record permissions must be 0600.",
        "Run the bridge as the credential owner or replace the credential record.",
      );
    }
    if (target.size > CREDENTIAL_RECORD_MAX_BYTES) {
      throw configurationError(
        "Credential record exceeds the supported size.",
        "Replace the oversized credential record before retrying.",
      );
    }
  }

  async #writeAtomically(targetPath: string, contents: Buffer): Promise<void> {
    const temporaryPath = join(
      this.#credentialsDirectory,
      `.credential.tmp-${process.pid}-${randomUUID()}`,
    );
    let handle: FileHandle | undefined;
    let temporaryExists = false;
    let renamed = false;
    let primary: unknown;

    try {
      handle = await open(temporaryPath, "wx", CREDENTIAL_FILE_MODE);
      temporaryExists = true;
      await handle.chmod(CREDENTIAL_FILE_MODE);
      await handle.writeFile(contents);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, targetPath);
      temporaryExists = false;
      renamed = true;
      await this.#syncDirectory();
    } catch (error) {
      primary = error;
    }

    if (handle !== undefined) {
      try {
        await handle.close();
      } catch (error) {
        if (primary === undefined) primary = error;
      }
    }
    if (temporaryExists) {
      try {
        await unlink(temporaryPath);
      } catch (error) {
        if (!isNodeError(error, "ENOENT") && primary === undefined) primary = error;
      }
    }
    if (primary !== undefined) {
      const operation = renamed ? "finalize" : "write";
      throw runtimeError(operation, primary);
    }
  }

  async #readDirectoryEntries() {
    try {
      return await readdir(this.#credentialsDirectory, { withFileTypes: true });
    } catch (error) {
      throw runtimeError("list", error);
    }
  }

  async #syncDirectory(): Promise<void> {
    let handle: FileHandle;
    try {
      handle = await open(this.#credentialsDirectory, "r");
    } catch (error) {
      throw runtimeError("open", error);
    }
    let primary: unknown;
    try {
      await handle.sync();
    } catch (error) {
      primary = error;
    }
    try {
      await handle.close();
    } catch (error) {
      if (primary === undefined) primary = error;
    }
    if (primary !== undefined) throw runtimeError("synchronize", primary);
  }
}
