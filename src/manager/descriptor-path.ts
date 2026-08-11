import { spawn } from "node:child_process";
import { readlink as nodeReadlink } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import { BridgeError } from "../domain/errors.js";

const DEFAULT_HELPER_PATH = fileURLToPath(
  new URL("../../dist/native/fd-path-helper", import.meta.url),
);
const MAX_CONFIGURED_TIMEOUT_MS = 30_000;
const MAX_CONFIGURED_OUTPUT_BYTES = 1024 * 1024;
const CONTROLLED_HELPER_ENV = Object.freeze({
  LANG: "C",
  LC_ALL: "C",
  PATH: "/usr/bin:/bin",
});

export const DEFAULT_DESCRIPTOR_PATH_TIMEOUT_MS = 2_000;
export const DEFAULT_DESCRIPTOR_PATH_MAX_OUTPUT_BYTES = 16 * 1024;

export interface DescriptorPathProcessOptions {
  readonly env: Readonly<Record<string, string>>;
  readonly maxOutputBytes: number;
  readonly stdio: readonly ["ignore", "pipe", "ignore", number];
  readonly timeoutMs: number;
}

export interface DescriptorPathProcessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: Buffer;
}

export interface DescriptorPathProcessRunner {
  run(
    executable: string,
    arguments_: readonly string[],
    options: DescriptorPathProcessOptions,
  ): Promise<DescriptorPathProcessResult>;
}

export interface DescriptorPathResolver {
  resolve(descriptor: number): Promise<string>;
}

export interface FdPathHelperDescriptorPathResolverOptions {
  readonly helperPath?: string;
  readonly run?: DescriptorPathProcessRunner["run"];
  readonly maxOutputBytes?: number;
  readonly timeoutMs?: number;
}

export interface ProcFdDescriptorPathResolverOptions {
  readonly readlink?: (path: string) => Promise<string>;
}

export interface DefaultDescriptorPathResolverOptions {
  readonly createFdPathHelperResolver?: () => DescriptorPathResolver;
  readonly createProcFdResolver?: () => DescriptorPathResolver;
  readonly platform?: NodeJS.Platform;
}

function positiveSafeInteger(name: string, value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new BridgeError("INVALID_ARGUMENT", `Invalid descriptor path resolver ${name}.`);
  }
  return value;
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function safeAbsolutePath(value: string): boolean {
  return (
    value.length > 0 &&
    isAbsolute(value) &&
    !hasControlCharacters(value) &&
    normalize(value) === value
  );
}

function resolutionFailure(): BridgeError {
  return new BridgeError(
    "UNAUTHORIZED",
    "The retained outbound file descriptor path could not be established safely.",
    "Rebuild the packaged fd-path helper and choose the attachment again.",
    { cause: new Error("Descriptor path resolution failed.") },
  );
}

const defaultRun: DescriptorPathProcessRunner["run"] = (executable, arguments_, options) =>
  new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable, [...arguments_], {
        env: { ...options.env },
        stdio: ["ignore", "pipe", "ignore", options.stdio[3]],
      });
    } catch (error) {
      reject(error);
      return;
    }

    const stdout = child.stdout;
    if (stdout === null) {
      child.kill("SIGKILL");
      reject(new Error("Descriptor path helper stdout was unavailable."));
      return;
    }

    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        reject(new Error("Descriptor path helper timed out."));
      }
    }, options.timeoutMs);
    const clear = () => clearTimeout(timer);

    stdout.on("data", (chunk: Buffer | string) => {
      if (settled) {
        return;
      }
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += bytes.length;
      if (outputBytes > options.maxOutputBytes) {
        settled = true;
        clear();
        child.kill("SIGKILL");
        reject(new Error("Descriptor path helper output exceeded its limit."));
        return;
      }
      chunks.push(bytes);
    });
    child.once("error", (error) => {
      if (!settled) {
        settled = true;
        clear();
        reject(error);
      }
    });
    child.once("close", (exitCode, signal) => {
      if (!settled) {
        settled = true;
        clear();
        resolve({ exitCode, signal, stdout: Buffer.concat(chunks, outputBytes) });
      }
    });
  });

export class FdPathHelperDescriptorPathResolver implements DescriptorPathResolver {
  readonly #helperPath: string;
  readonly #run: DescriptorPathProcessRunner["run"];
  readonly #maxOutputBytes: number;
  readonly #timeoutMs: number;

  constructor(options: FdPathHelperDescriptorPathResolverOptions = {}) {
    this.#helperPath = options.helperPath ?? DEFAULT_HELPER_PATH;
    if (!safeAbsolutePath(this.#helperPath)) {
      throw new BridgeError("INVALID_ARGUMENT", "Invalid descriptor path helper location.");
    }
    this.#run = options.run ?? defaultRun;
    this.#maxOutputBytes = positiveSafeInteger(
      "maxOutputBytes",
      options.maxOutputBytes ?? DEFAULT_DESCRIPTOR_PATH_MAX_OUTPUT_BYTES,
      MAX_CONFIGURED_OUTPUT_BYTES,
    );
    this.#timeoutMs = positiveSafeInteger(
      "timeoutMs",
      options.timeoutMs ?? DEFAULT_DESCRIPTOR_PATH_TIMEOUT_MS,
      MAX_CONFIGURED_TIMEOUT_MS,
    );
  }

  async resolve(descriptor: number): Promise<string> {
    if (!Number.isSafeInteger(descriptor) || descriptor < 0) {
      throw resolutionFailure();
    }

    try {
      const result = await this.#run(this.#helperPath, [], {
        env: CONTROLLED_HELPER_ENV,
        maxOutputBytes: this.#maxOutputBytes,
        stdio: ["ignore", "pipe", "ignore", descriptor],
        timeoutMs: this.#timeoutMs,
      });
      if (
        result.exitCode !== 0 ||
        result.signal !== null ||
        !Buffer.isBuffer(result.stdout) ||
        result.stdout.length === 0 ||
        result.stdout.length > this.#maxOutputBytes
      ) {
        throw resolutionFailure();
      }
      const path = new TextDecoder("utf-8", { fatal: true }).decode(result.stdout);
      if (!safeAbsolutePath(path)) {
        throw resolutionFailure();
      }
      return path;
    } catch {
      throw resolutionFailure();
    }
  }
}

export class ProcFdDescriptorPathResolver implements DescriptorPathResolver {
  readonly #readlink: (path: string) => Promise<string>;

  constructor(options: ProcFdDescriptorPathResolverOptions = {}) {
    this.#readlink = options.readlink ?? nodeReadlink;
  }

  async resolve(descriptor: number): Promise<string> {
    if (!Number.isSafeInteger(descriptor) || descriptor < 0) {
      throw resolutionFailure();
    }

    try {
      const path = await this.#readlink(`/proc/self/fd/${descriptor}`);
      if (!safeAbsolutePath(path) || path.endsWith(" (deleted)")) {
        throw resolutionFailure();
      }
      return path;
    } catch {
      throw resolutionFailure();
    }
  }
}

export function createDefaultDescriptorPathResolver(
  options: DefaultDescriptorPathResolverOptions = {},
): DescriptorPathResolver {
  const platform = options.platform ?? process.platform;
  if (platform === "darwin") {
    return (
      options.createFdPathHelperResolver ?? (() => new FdPathHelperDescriptorPathResolver())
    )();
  }
  if (platform === "linux") {
    return (options.createProcFdResolver ?? (() => new ProcFdDescriptorPathResolver()))();
  }
  throw new BridgeError(
    "CONFIGURATION",
    `Unsupported descriptor-path platform: ${platform}.`,
    "Run the bridge on macOS or Linux.",
  );
}

export const defaultDescriptorPathResolver: DescriptorPathResolver =
  createDefaultDescriptorPathResolver();
