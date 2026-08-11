import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, type FileHandle, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { lock } from "proper-lockfile";
import type { z } from "zod";
import { BridgeError } from "../domain/errors.js";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const LOCK_STALE_MS = 10_000;
const LOCK_UPDATE_MS = 2_000;
const EXISTING_FILE_OPEN_FLAGS =
  fsConstants.O_RDONLY |
  fsConstants.O_NONBLOCK |
  (typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0);
const LOCK_TARGET_OPEN_FLAGS =
  fsConstants.O_RDWR |
  fsConstants.O_CREAT |
  fsConstants.O_NONBLOCK |
  (typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0);

const LOCK_RETRY_OPTIONS = {
  retries: 8,
  factor: 1.5,
  minTimeout: 25,
  maxTimeout: 250,
  randomize: false,
} as const;

export type AtomicWriteFaultPoint =
  | "after-temp-file-fsync"
  | "after-rename"
  | "after-directory-fsync"
  | "before-temp-file-cleanup"
  | "before-lock-release";

export type AtomicWriteFaultInjector = (point: AtomicWriteFaultPoint) => void | Promise<void>;

export type AtomicJsonEvent =
  | "temp-file-synced"
  | "temp-file-closed"
  | "file-renamed"
  | "directory-synced"
  | "lock-released";

export type AtomicJsonEventObserver = (event: AtomicJsonEvent) => void;

export type AtomicLockRelease = () => Promise<void>;
export type AtomicLockAdapter = (
  targetPath: string,
  acquire: () => Promise<AtomicLockRelease>,
) => Promise<AtomicLockRelease>;

export interface AtomicJsonMutation<T, R> {
  document: T;
  result: R;
}

export interface AtomicJsonStoreOptions<T> {
  filePath: string;
  schema: z.ZodType<T>;
  initialDocument: () => T;
  faultInjector?: AtomicWriteFaultInjector;
  eventObserver?: AtomicJsonEventObserver;
  lockAdapter?: AtomicLockAdapter;
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function capture<T>(operation: () => T | Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    return { ok: false, error };
  }
}

function aggregateFailures(
  primary: unknown,
  secondary: readonly unknown[],
  message: string,
): unknown {
  if (secondary.length === 0) {
    return primary;
  }
  return new AggregateError([primary, ...secondary], message, {
    cause: primary,
  });
}

function releaseFailure(error: unknown, committed: boolean): BridgeError {
  return new BridgeError(
    "RUNTIME",
    committed
      ? "Registry commit succeeded but lock release failed"
      : "Registry lock release failed",
    committed
      ? "Do not retry automatically; inspect registry state and lock ownership first."
      : "Inspect lock ownership before retrying.",
    { cause: error },
  );
}

function postCommitFailure(error: unknown): BridgeError {
  return new BridgeError(
    "RUNTIME",
    "Registry rename committed but durability finalization failed",
    "Do not retry automatically; inspect the committed registry before taking further action.",
    { cause: error },
  );
}

function preReleaseHookFailure(error: unknown, committed: boolean): BridgeError {
  return new BridgeError(
    "RUNTIME",
    committed
      ? "Registry commit succeeded but pre-release fault hook failed"
      : "Registry pre-release fault hook failed",
    committed
      ? "Do not retry automatically; inspect the committed registry before continuing."
      : "Inspect the injected fault hook before retrying.",
    { cause: error },
  );
}

async function closeHandle(handle: FileHandle): Promise<Outcome<void>> {
  return capture(() => handle.close());
}

export class AtomicJsonStore<T> {
  readonly filePath: string;
  readonly lockTargetPath: string;

  readonly #schema: z.ZodType<T>;
  readonly #initialDocument: () => T;
  readonly #faultInjector: AtomicWriteFaultInjector | undefined;
  readonly #eventObserver: AtomicJsonEventObserver | undefined;
  readonly #lockAdapter: AtomicLockAdapter | undefined;

  constructor(options: AtomicJsonStoreOptions<T>) {
    this.filePath = options.filePath;
    this.lockTargetPath = `${options.filePath}.lock-target`;
    this.#schema = options.schema;
    this.#initialDocument = options.initialDocument;
    this.#faultInjector = options.faultInjector;
    this.#eventObserver = options.eventObserver;
    this.#lockAdapter = options.lockAdapter;
  }

  async read(): Promise<T> {
    return this.#withLock(async (markCommitted) => {
      const current = await this.#readCurrent();
      if (current === undefined) {
        const initial = this.#validate(this.#initialDocument(), "initial document");
        await this.#write(initial, markCommitted);
        return this.#validate(initial, "committed document");
      }

      return current;
    });
  }

  async transact<R>(
    mutate: (current: T) => AtomicJsonMutation<T, R> | Promise<AtomicJsonMutation<T, R>>,
  ): Promise<R> {
    return this.#withLock(async (markCommitted) => {
      const current =
        (await this.#readCurrent()) ?? this.#validate(this.#initialDocument(), "initial document");
      const mutation = await mutate(current);
      const next = this.#validate(mutation.document, "next document");
      await this.#write(next, markCommitted);
      return mutation.result;
    });
  }

  async update(mutate: (current: T) => T | Promise<T>): Promise<T> {
    return this.transact(async (current) => {
      const document = await mutate(current);
      return { document, result: document };
    });
  }

  async #ensureLockTarget(): Promise<void> {
    const parent = dirname(this.filePath);
    await mkdir(parent, { mode: DIRECTORY_MODE, recursive: true });
    await chmod(parent, DIRECTORY_MODE);

    let handle: FileHandle;
    try {
      handle = await open(this.lockTargetPath, LOCK_TARGET_OPEN_FLAGS, FILE_MODE);
    } catch (error) {
      if (isNodeError(error, "ELOOP")) {
        throw new BridgeError(
          "CONFIGURATION",
          `Lock target must not be a symbolic link: ${this.lockTargetPath}`,
          "Replace the symbolic link with a regular owner-controlled lock target file.",
          { cause: error },
        );
      }
      if (isNodeError(error, "EISDIR")) {
        throw new BridgeError(
          "CONFIGURATION",
          `Lock target must reference a regular file: ${this.lockTargetPath}`,
          "Move the directory and retry with a regular lock target file.",
          { cause: error },
        );
      }
      throw error;
    }

    const setupOutcome = await capture(async () => {
      const target = await handle.stat();
      if (!target.isFile()) {
        throw new BridgeError(
          "CONFIGURATION",
          `Lock target must reference a regular file: ${this.lockTargetPath}`,
          "Move the non-regular target and retry with a regular lock target file.",
        );
      }
      await handle.chmod(FILE_MODE);
    });
    const closeOutcome = await closeHandle(handle);
    if (!setupOutcome.ok) {
      throw aggregateFailures(
        setupOutcome.error,
        closeOutcome.ok ? [] : [closeOutcome.error],
        "Lock target setup and handle cleanup both failed",
      );
    }
    if (!closeOutcome.ok) {
      throw closeOutcome.error;
    }
  }

  async #withLock<R>(operation: (markCommitted: () => void) => Promise<R>): Promise<R> {
    await this.#ensureLockTarget();

    let release: AtomicLockRelease | undefined;
    let committed = false;
    const operationOutcome = await capture(async () => {
      const acquire = () =>
        lock(this.lockTargetPath, {
          realpath: false,
          stale: LOCK_STALE_MS,
          update: LOCK_UPDATE_MS,
          retries: LOCK_RETRY_OPTIONS,
        });
      release =
        this.#lockAdapter === undefined
          ? await acquire()
          : await this.#lockAdapter(this.lockTargetPath, acquire);
      if (typeof release !== "function") {
        throw new BridgeError("RUNTIME", "Registry lock adapter returned an invalid release");
      }
      await this.#cleanupOrphanTemps();
      return operation(() => {
        committed = true;
      });
    });

    let hookFailure: BridgeError | undefined;
    let normalizedReleaseError: BridgeError | undefined;
    if (release !== undefined) {
      const hookOutcome = await capture(() => this.#injectFault("before-lock-release"));
      if (!hookOutcome.ok) {
        hookFailure = preReleaseHookFailure(hookOutcome.error, committed);
      }
      const releaseOutcome = await capture(release);
      if (releaseOutcome.ok) {
        this.#emit("lock-released");
      } else {
        normalizedReleaseError = releaseFailure(releaseOutcome.error, committed);
      }
    }

    if (!operationOutcome.ok) {
      const secondary = [hookFailure, normalizedReleaseError].filter(
        (error): error is BridgeError => error !== undefined,
      );
      throw aggregateFailures(
        operationOutcome.error,
        secondary,
        "Registry operation and finalization both failed",
      );
    }
    if (hookFailure !== undefined) {
      throw aggregateFailures(
        hookFailure,
        normalizedReleaseError === undefined ? [] : [normalizedReleaseError],
        "Registry pre-release hook and lock release both failed",
      );
    }
    if (normalizedReleaseError !== undefined) {
      throw normalizedReleaseError;
    }
    return operationOutcome.value;
  }

  async #cleanupOrphanTemps(): Promise<void> {
    const parent = dirname(this.filePath);
    const prefix = `.${basename(this.filePath)}.tmp-`;
    const entries = await readdir(parent, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name.startsWith(prefix) && !entry.isDirectory()) {
        await unlink(join(parent, entry.name));
      }
    }
  }

  async #readCurrent(): Promise<T | undefined> {
    let handle: FileHandle;
    try {
      handle = await open(this.filePath, EXISTING_FILE_OPEN_FLAGS);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        return undefined;
      }
      if (isNodeError(error, "ELOOP")) {
        throw new BridgeError(
          "CONFIGURATION",
          `Registry path must not be a symbolic link: ${this.filePath}`,
          "Replace the symbolic link with a regular owner-controlled registry file.",
          { cause: error },
        );
      }
      throw error;
    }

    const readOutcome = await capture(async () => {
      const target = await handle.stat();
      if (!target.isFile()) {
        throw new BridgeError(
          "CONFIGURATION",
          `Registry path must reference a regular file: ${this.filePath}`,
          "Move the non-regular target and retry with a regular registry file.",
        );
      }
      await handle.chmod(FILE_MODE);
      const contents = await handle.readFile("utf8");
      let value: unknown;
      try {
        value = JSON.parse(contents);
      } catch (error) {
        throw new BridgeError(
          "CONFIGURATION",
          `Refusing to overwrite malformed JSON state at ${this.filePath}`,
          "Repair or restore the registry before retrying.",
          { cause: error },
        );
      }
      return this.#validate(value, `persisted state at ${this.filePath}`);
    });

    const closeOutcome = await closeHandle(handle);
    if (!readOutcome.ok) {
      throw aggregateFailures(
        readOutcome.error,
        closeOutcome.ok ? [] : [closeOutcome.error],
        "Registry read and handle cleanup both failed",
      );
    }
    if (!closeOutcome.ok) {
      throw closeOutcome.error;
    }
    return readOutcome.value;
  }

  #validate(value: unknown, source: string): T {
    const result = this.#schema.safeParse(value);
    if (!result.success) {
      throw new BridgeError(
        "CONFIGURATION",
        `Refusing to persist invalid ${source}`,
        "Repair the registry data or correct the requested operation.",
        { cause: result.error },
      );
    }
    return result.data;
  }

  async #injectFault(point: AtomicWriteFaultPoint): Promise<void> {
    await this.#faultInjector?.(point);
  }

  #emit(event: AtomicJsonEvent): void {
    try {
      this.#eventObserver?.(event);
    } catch {
      // Observers are test-only diagnostics and cannot alter persistence.
    }
  }

  async #syncDirectory(parent: string): Promise<void> {
    const handle = await open(parent, "r");
    const syncOutcome = await capture(async () => {
      await handle.sync();
      this.#emit("directory-synced");
      await this.#injectFault("after-directory-fsync");
    });

    const closeOutcome = await closeHandle(handle);
    if (!syncOutcome.ok) {
      throw aggregateFailures(
        syncOutcome.error,
        closeOutcome.ok ? [] : [closeOutcome.error],
        "Directory sync and handle cleanup both failed",
      );
    }
    if (!closeOutcome.ok) {
      throw closeOutcome.error;
    }
  }

  async #write(document: T, markCommitted: () => void): Promise<void> {
    const parent = dirname(this.filePath);
    const tempPath = join(parent, `.${basename(this.filePath)}.tmp-${process.pid}-${randomUUID()}`);
    let handle: FileHandle | undefined;
    let tempExists = false;
    let renamed = false;

    const writeOutcome = await capture(async () => {
      handle = await open(tempPath, "wx", FILE_MODE);
      tempExists = true;
      await handle.chmod(FILE_MODE);
      await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, "utf8");
      await handle.sync();
      this.#emit("temp-file-synced");
      await this.#injectFault("after-temp-file-fsync");

      await handle.close();
      handle = undefined;
      this.#emit("temp-file-closed");
      await rename(tempPath, this.filePath);
      tempExists = false;
      renamed = true;
      markCommitted();
      this.#emit("file-renamed");
      await this.#injectFault("after-rename");

      await this.#syncDirectory(parent);
    });

    const cleanupErrors: unknown[] = [];
    if (handle !== undefined) {
      const closeOutcome = await closeHandle(handle);
      if (!closeOutcome.ok) {
        cleanupErrors.push(closeOutcome.error);
      }
    }
    if (tempExists) {
      const hookOutcome = await capture(() => this.#injectFault("before-temp-file-cleanup"));
      if (!hookOutcome.ok) {
        cleanupErrors.push(hookOutcome.error);
      }
      const unlinkOutcome = await capture(() => unlink(tempPath));
      if (!unlinkOutcome.ok && !isNodeError(unlinkOutcome.error, "ENOENT")) {
        cleanupErrors.push(unlinkOutcome.error);
      }
    }

    if (!writeOutcome.ok) {
      const failure = aggregateFailures(
        writeOutcome.error,
        cleanupErrors,
        "Registry write and temporary-file cleanup both failed",
      );
      throw renamed ? postCommitFailure(failure) : failure;
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        cleanupErrors,
        "Temporary-file cleanup failed after registry write",
        { cause: cleanupErrors[0] },
      );
    }
  }
}
