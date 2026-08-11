import {
  constants as fsConstants,
  lstat as nodeLstat,
  realpath as nodeRealpath,
  stat as nodeStat,
  type Stats,
} from "node:fs";
import { type FileHandle, open as nodeOpen } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { z } from "zod";
import { BridgeError } from "../domain/errors.js";
import {
  IdentifierSchema,
  type WorkspaceProfile,
  WorkspaceProfileSchema,
} from "../domain/schemas.js";
import { type DescriptorPathResolver, defaultDescriptorPathResolver } from "./descriptor-path.js";

const realpath = promisify(nodeRealpath);
const lstat = promisify(nodeLstat);
const stat = promisify(nodeStat);
const WORKSPACE_REMEDIATION =
  "Update the workspace profile to use existing approved directories and supported Codex settings.";
const FILE_REMEDIATION =
  "Choose an existing regular file inside the approved workspace or instance inbox.";
export const DEFAULT_MAX_OUTBOUND_FILE_BYTES = 25 * 1024 * 1024;
const OUTBOUND_FILE_OPEN_FLAGS =
  fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;

const ApprovalPolicySchema = z.enum(["untrusted", "on-request", "never"]);
const SandboxSchema = z.enum(["read-only", "workspace-write", "danger-full-access"]);
const BridgePathMetadataSchema = z
  .object({
    root: z.string().min(1),
    registryPath: z.string().min(1),
    logsDirectory: z.string().min(1),
    instancesDirectory: z.string().min(1),
    inboxDirectory: z.string().min(1),
    managerStatePaths: z.array(z.string().min(1)),
  })
  .strict();

export interface BridgePathMetadata {
  readonly root: string;
  readonly registryPath: string;
  readonly logsDirectory: string;
  readonly instancesDirectory: string;
  readonly inboxDirectory: string;
  readonly managerStatePaths: readonly string[];
}

export interface WorkspaceFileSystem {
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<Pick<Stats, "isDirectory" | "isFile">>;
}

export type OutboundFileHandle = Pick<FileHandle, "close" | "createReadStream" | "fd" | "stat">;

export interface OutboundFileSystem extends WorkspaceFileSystem {
  lstat(path: string): Promise<Stats>;
  open(path: string, flags: number): Promise<OutboundFileHandle>;
  stat(path: string): Promise<Stats>;
}

export type NormalizedApprovalPolicy = z.infer<typeof ApprovalPolicySchema>;
export type NormalizedSandbox = z.infer<typeof SandboxSchema>;

export interface NormalizedWorkspace {
  readonly name: string;
  readonly cwd: string;
  readonly configuredRuntimeWorkspaceRoots: readonly string[];
  readonly runtimeWorkspaceRoots: readonly string[];
  readonly instanceInbox: string;
  readonly approvalPolicy: NormalizedApprovalPolicy;
  readonly permissions?: string;
  readonly sandbox?: NormalizedSandbox;
  readonly model?: string;
  readonly serviceTier?: string;
  readonly developerInstructions?: string;
  readonly bridgePaths: BridgePathMetadata;
}

export interface WorkspaceNormalizerOptions {
  readonly bridgePaths: BridgePathMetadata;
  readonly fileSystem?: WorkspaceFileSystem;
}

export interface OutboundFileValidationContext {
  readonly workspace: NormalizedWorkspace;
  readonly fileSystem?: OutboundFileSystem;
  readonly descriptorPathResolver?: DescriptorPathResolver;
  readonly maxFileBytes?: number;
}

/** Caller owns the retained descriptor and must close it after upload. */
export interface AuthorizedOutboundFile {
  readonly canonicalPath: string;
  readonly displayFilename: string;
  readonly size: number;
  readonly isClosed: boolean;
  createReadStream(): Readable;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

export interface PreparedOutboundFileValidation {
  authorize(pathInput: unknown): Promise<AuthorizedOutboundFile>;
}

interface CanonicalBridgePaths {
  readonly root: string;
  readonly inboxDirectory: string;
  readonly containerProtectedPaths: readonly string[];
  readonly hardProtectedPaths: readonly string[];
}

const defaultFileSystem: WorkspaceFileSystem = {
  realpath,
  stat,
};

const defaultOutboundFileSystem: OutboundFileSystem = {
  lstat,
  open: nodeOpen,
  realpath,
  stat,
};

function safeCause(error: unknown): Error {
  const code = fileSystemErrorCode(error);
  return new Error(
    code === undefined ? "Filesystem operation failed." : `Filesystem error ${code}.`,
  );
}

function fileSystemErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

function configurationError(message: string, cause?: unknown): BridgeError {
  return new BridgeError(
    "CONFIGURATION",
    message,
    WORKSPACE_REMEDIATION,
    cause === undefined ? undefined : { cause: safeCause(cause) },
  );
}

function runtimeFileError(
  code: "INVALID_ARGUMENT" | "NOT_FOUND" | "UNAUTHORIZED",
  message: string,
) {
  return new BridgeError(code, message, FILE_REMEDIATION);
}

function isSafeAbsolutePath(path: string): boolean {
  return path.length > 0 && isAbsolute(path) && !hasControlCharacters(path);
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

function containsPath(parent: string, child: string): boolean {
  const difference = relative(parent, child);
  return difference === "" || (!difference.startsWith(`..${sep}`) && difference !== "..");
}

function pathsOverlap(first: string, second: string): boolean {
  return containsPath(first, second) || containsPath(second, first);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function freezeStrings(values: readonly string[]): readonly string[] {
  return Object.freeze([...values]);
}

function freezeBridgePaths(paths: BridgePathMetadata): BridgePathMetadata {
  return Object.freeze({
    root: paths.root,
    registryPath: paths.registryPath,
    logsDirectory: paths.logsDirectory,
    instancesDirectory: paths.instancesDirectory,
    inboxDirectory: paths.inboxDirectory,
    managerStatePaths: freezeStrings(paths.managerStatePaths),
  });
}

function parseBridgePaths(value: BridgePathMetadata): BridgePathMetadata {
  const parsed = BridgePathMetadataSchema.safeParse(value);
  if (!parsed.success) {
    throw configurationError("Bridge path metadata is invalid.");
  }
  const paths = parsed.data;
  for (const path of [
    paths.root,
    paths.registryPath,
    paths.logsDirectory,
    paths.instancesDirectory,
    paths.inboxDirectory,
    ...paths.managerStatePaths,
  ]) {
    if (!isSafeAbsolutePath(path)) {
      throw configurationError("Bridge path metadata must contain only absolute paths.");
    }
  }
  return freezeBridgePaths(paths);
}

async function canonicalizePotentialPath(
  input: string,
  fileSystem: WorkspaceFileSystem,
): Promise<string> {
  const absolute = resolve(input);
  let candidate = absolute;
  const missingSegments: string[] = [];

  for (;;) {
    try {
      const existing = await fileSystem.realpath(candidate);
      const canonical = resolve(existing, ...missingSegments);
      if (!isSafeAbsolutePath(existing) || !isSafeAbsolutePath(canonical)) {
        throw configurationError("Bridge path metadata resolved to an unsafe path.");
      }
      return canonical;
    } catch (error) {
      if (fileSystemErrorCode(error) !== "ENOENT") {
        throw configurationError("Bridge path metadata could not be canonicalized.", error);
      }
      const parent = dirname(candidate);
      if (parent === candidate) {
        throw configurationError("Bridge path metadata could not be canonicalized.", error);
      }
      missingSegments.unshift(basename(candidate));
      candidate = parent;
    }
  }
}

async function canonicalBridgePaths(
  paths: BridgePathMetadata,
  fileSystem: WorkspaceFileSystem,
): Promise<CanonicalBridgePaths> {
  const root = await canonicalizePotentialPath(paths.root, fileSystem);
  const inboxDirectory = await canonicalizePotentialPath(paths.inboxDirectory, fileSystem);
  const containerProtectedPaths = unique([root, inboxDirectory]);
  const hardProtectedPaths = unique(
    await Promise.all(
      [
        paths.registryPath,
        paths.logsDirectory,
        paths.instancesDirectory,
        ...paths.managerStatePaths,
      ].map((path) => canonicalizePotentialPath(path, fileSystem)),
    ),
  );

  for (const path of [...containerProtectedPaths, ...hardProtectedPaths]) {
    if (!containsPath(root, path)) {
      throw configurationError("Bridge path metadata escapes its state root.");
    }
  }

  return {
    root,
    inboxDirectory,
    containerProtectedPaths: freezeStrings(containerProtectedPaths),
    hardProtectedPaths: freezeStrings(hardProtectedPaths),
  };
}

async function canonicalExistingDirectory(
  input: string,
  label: string,
  fileSystem: WorkspaceFileSystem,
): Promise<string> {
  if (!isSafeAbsolutePath(input)) {
    throw configurationError(`${label} must be an absolute directory.`);
  }

  let canonical: string;
  let metadata: Pick<Stats, "isDirectory">;
  try {
    canonical = await fileSystem.realpath(input);
    metadata = await fileSystem.stat(canonical);
  } catch (error) {
    throw configurationError(`${label} is missing or inaccessible.`, error);
  }
  if (!isSafeAbsolutePath(canonical) || !metadata.isDirectory()) {
    throw configurationError(`${label} must resolve to a directory.`);
  }
  return canonical;
}

function directInstanceId(sharedInbox: string, instanceInbox: string): string | undefined {
  const difference = relative(sharedInbox, instanceInbox);
  if (
    difference === "" ||
    difference === ".." ||
    difference.startsWith(`..${sep}`) ||
    difference.includes(sep)
  ) {
    return undefined;
  }
  const parsed = IdentifierSchema.safeParse(difference);
  return parsed.success ? parsed.data : undefined;
}

function assertApprovedProfileRoot(
  candidate: string,
  bridge: CanonicalBridgePaths,
  label: string,
): void {
  if (bridge.hardProtectedPaths.some((protectedPath) => pathsOverlap(candidate, protectedPath))) {
    throw configurationError(`${label} overlaps hard protected bridge state.`);
  }
  if (
    bridge.containerProtectedPaths.some((protectedPath) => pathsOverlap(candidate, protectedPath))
  ) {
    throw configurationError(`${label} overlaps protected bridge state.`);
  }
}

function parseProfile(value: WorkspaceProfile): Omit<
  WorkspaceProfile,
  "approvalPolicy" | "sandbox"
> & {
  approvalPolicy: NormalizedApprovalPolicy;
  sandbox?: NormalizedSandbox;
} {
  const parsed = WorkspaceProfileSchema.safeParse(value);
  if (!parsed.success) {
    throw configurationError("Workspace profile is malformed.");
  }
  const approvalPolicy = ApprovalPolicySchema.safeParse(parsed.data.approvalPolicy);
  const sandbox = SandboxSchema.optional().safeParse(parsed.data.sandbox);
  if (!approvalPolicy.success || !sandbox.success) {
    throw configurationError("Workspace profile uses an unsupported Codex policy.");
  }
  if ((parsed.data.permissions === undefined) === (parsed.data.sandbox === undefined)) {
    throw configurationError("Workspace profile must define exactly one permission mode.");
  }
  const { approvalPolicy: _approvalPolicy, sandbox: _sandbox, ...profile } = parsed.data;
  return {
    ...profile,
    approvalPolicy: approvalPolicy.data,
    ...(sandbox.data === undefined ? {} : { sandbox: sandbox.data }),
  };
}

export class WorkspaceNormalizer {
  private readonly bridgePaths: BridgePathMetadata;
  private readonly fileSystem: WorkspaceFileSystem;

  constructor(options: WorkspaceNormalizerOptions) {
    this.bridgePaths = parseBridgePaths(options.bridgePaths);
    this.fileSystem = options.fileSystem ?? defaultFileSystem;
  }

  async normalize(
    profileInput: WorkspaceProfile,
    instanceInboxInput: string,
  ): Promise<NormalizedWorkspace> {
    const profile = parseProfile(profileInput);
    const bridge = await canonicalBridgePaths(this.bridgePaths, this.fileSystem);
    const lexicalInstanceId = directInstanceId(
      resolve(this.bridgePaths.inboxDirectory),
      resolve(instanceInboxInput),
    );
    if (lexicalInstanceId === undefined) {
      throw configurationError("Instance inbox must be one manager-derived inbox directory.");
    }
    const cwd = await canonicalExistingDirectory(profile.cwd, "Workspace cwd", this.fileSystem);
    const configuredRoots: string[] = [];
    const seenRoots = new Set<string>();
    for (const root of profile.runtimeWorkspaceRoots) {
      const canonical = await canonicalExistingDirectory(
        root,
        "Runtime workspace root",
        this.fileSystem,
      );
      if (!seenRoots.has(canonical)) {
        configuredRoots.push(canonical);
        seenRoots.add(canonical);
      }
    }
    const instanceInbox = await canonicalExistingDirectory(
      instanceInboxInput,
      "Instance inbox",
      this.fileSystem,
    );

    if (instanceInbox !== resolve(bridge.inboxDirectory, lexicalInstanceId)) {
      throw configurationError("Instance inbox does not match its manager-derived canonical path.");
    }

    if (
      bridge.hardProtectedPaths.some((protectedPath) => containsPath(protectedPath, instanceInbox))
    ) {
      throw configurationError("Instance inbox is itself hard protected bridge state.");
    }

    assertApprovedProfileRoot(cwd, bridge, "Workspace cwd");
    for (const root of configuredRoots) {
      assertApprovedProfileRoot(root, bridge, "Runtime workspace root");
    }
    const runtimeRoots = [...configuredRoots];
    if (!seenRoots.has(instanceInbox)) {
      runtimeRoots.push(instanceInbox);
    }

    return Object.freeze({
      name: profile.name,
      cwd,
      configuredRuntimeWorkspaceRoots: freezeStrings(configuredRoots),
      runtimeWorkspaceRoots: freezeStrings(runtimeRoots),
      instanceInbox,
      approvalPolicy: profile.approvalPolicy,
      ...(profile.permissions === undefined ? {} : { permissions: profile.permissions }),
      ...(profile.sandbox === undefined ? {} : { sandbox: profile.sandbox }),
      ...(profile.model === undefined ? {} : { model: profile.model }),
      ...(profile.serviceTier === undefined ? {} : { serviceTier: profile.serviceTier }),
      ...(profile.developerInstructions === undefined
        ? {}
        : { developerInstructions: profile.developerInstructions }),
      bridgePaths: this.bridgePaths,
    });
  }
}

async function revalidateApprovedDirectory(
  path: string,
  fileSystem: WorkspaceFileSystem,
): Promise<string> {
  try {
    const current = await fileSystem.realpath(path);
    const metadata = await fileSystem.stat(current);
    if (!isSafeAbsolutePath(current) || current !== path || !metadata.isDirectory()) {
      throw runtimeFileError("UNAUTHORIZED", "An approved file root changed after validation.");
    }
    return current;
  } catch (error) {
    if (error instanceof BridgeError) {
      throw error;
    }
    throw runtimeFileError("UNAUTHORIZED", "An approved file root is no longer accessible.");
  }
}

function configuredMaxFileBytes(value: number | undefined): number {
  const maximum = value ?? DEFAULT_MAX_OUTBOUND_FILE_BYTES;
  if (!Number.isSafeInteger(maximum) || maximum <= 0) {
    throw runtimeFileError("INVALID_ARGUMENT", "The outbound file byte limit is invalid.");
  }
  return maximum;
}

async function canonicalOutboundPath(
  input: string,
  fileSystem: OutboundFileSystem,
): Promise<string> {
  try {
    const canonical = await fileSystem.realpath(input);
    if (!isSafeAbsolutePath(canonical)) {
      throw runtimeFileError("INVALID_ARGUMENT", "The outbound file resolved to an unsafe path.");
    }
    return canonical;
  } catch (error) {
    if (error instanceof BridgeError) {
      throw error;
    }
    const code = fileSystemErrorCode(error);
    if (code === "ENOENT") {
      throw runtimeFileError("NOT_FOUND", "The outbound file does not exist.");
    }
    if (code === "EACCES" || code === "EPERM") {
      throw runtimeFileError("UNAUTHORIZED", "The outbound file is not accessible.");
    }
    throw runtimeFileError("INVALID_ARGUMENT", "The outbound file path cannot be resolved.");
  }
}

function sameFileSnapshot(first: Stats, second: Stats): boolean {
  return (
    first.dev === second.dev &&
    first.ino === second.ino &&
    first.mode === second.mode &&
    first.size === second.size
  );
}

async function snapshotOutboundFile(
  canonicalPath: string,
  fileSystem: OutboundFileSystem,
): Promise<Stats> {
  try {
    const linkSnapshot = await fileSystem.lstat(canonicalPath);
    const targetSnapshot = await fileSystem.stat(canonicalPath);
    if (
      !linkSnapshot.isFile() ||
      !targetSnapshot.isFile() ||
      !sameFileSnapshot(linkSnapshot, targetSnapshot)
    ) {
      throw runtimeFileError("INVALID_ARGUMENT", "The outbound path is not a stable regular file.");
    }
    if (targetSnapshot.nlink !== 1) {
      throw runtimeFileError("UNAUTHORIZED", "Hard-linked files cannot be attached.");
    }
    return targetSnapshot;
  } catch (error) {
    if (error instanceof BridgeError) {
      throw error;
    }
    const code = fileSystemErrorCode(error);
    if (code === "ENOENT") {
      throw runtimeFileError("NOT_FOUND", "The outbound file does not exist.");
    }
    if (code === "EACCES" || code === "EPERM") {
      throw runtimeFileError("UNAUTHORIZED", "The outbound file is not accessible.");
    }
    throw runtimeFileError("INVALID_ARGUMENT", "The outbound file metadata cannot be read.");
  }
}

function openedFileFailure(error: unknown): BridgeError {
  if (error instanceof BridgeError) {
    return error;
  }
  const code = fileSystemErrorCode(error);
  if (code === "EACCES" || code === "EPERM" || code === "ELOOP" || code === "ENOENT") {
    return runtimeFileError("UNAUTHORIZED", "The outbound file changed during authorization.");
  }
  return runtimeFileError("INVALID_ARGUMENT", "The outbound file could not be opened safely.");
}

function withSafeCloseFailure(primary: BridgeError): BridgeError {
  return new BridgeError(primary.code, primary.message, primary.remediation, {
    cause: new AggregateError(
      [new Error("Outbound file authorization failed."), new Error("File handle cleanup failed.")],
      "Outbound file authorization and cleanup both failed.",
    ),
  });
}

interface OutboundFileIdentity {
  readonly dev: number;
  readonly ino: number;
}

const authorizedFileIdentities = new WeakMap<object, OutboundFileIdentity>();

class RetainedAuthorizedOutboundFile implements AuthorizedOutboundFile {
  readonly canonicalPath: string;
  readonly displayFilename: string;
  readonly size: number;

  readonly #handle: OutboundFileHandle;
  #closePromise: Promise<void> | undefined;
  #closed = false;

  constructor(
    canonicalPath: string,
    size: number,
    identity: OutboundFileIdentity,
    handle: OutboundFileHandle,
  ) {
    this.canonicalPath = canonicalPath;
    this.displayFilename = basename(canonicalPath);
    this.size = size;
    this.#handle = handle;
    authorizedFileIdentities.set(this, identity);
    Object.freeze(this);
  }

  get isClosed(): boolean {
    return this.#closed;
  }

  createReadStream(): Readable {
    if (this.#closed) {
      throw new BridgeError(
        "RUNTIME",
        "The authorized outbound file is already closed.",
        "Authorize the attachment again before starting a new upload.",
      );
    }
    if (this.size === 0) {
      return Readable.from([]);
    }
    return this.#handle.createReadStream({ autoClose: false, end: this.size - 1, start: 0 });
  }

  close(): Promise<void> {
    if (this.#closePromise === undefined) {
      this.#closed = true;
      this.#closePromise = this.#handle.close().catch(() => {
        throw new BridgeError(
          "RUNTIME",
          "The authorized outbound file handle could not be closed.",
          "Stop the upload and inspect process file descriptor usage.",
          { cause: new Error("File handle close failed.") },
        );
      });
    }
    return this.#closePromise;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

export function authorizedOutboundFilesShareIdentity(
  first: AuthorizedOutboundFile,
  second: AuthorizedOutboundFile,
): boolean {
  const firstIdentity = authorizedFileIdentities.get(first);
  const secondIdentity = authorizedFileIdentities.get(second);
  return (
    firstIdentity !== undefined &&
    secondIdentity !== undefined &&
    firstIdentity.dev === secondIdentity.dev &&
    firstIdentity.ino === secondIdentity.ino
  );
}

async function openAuthorizedOutboundFile(
  canonicalPath: string,
  snapshot: Stats,
  maximumBytes: number,
  fileSystem: OutboundFileSystem,
  descriptorPathResolver: DescriptorPathResolver,
  assertAllowedPath: (canonicalPath: string) => void,
): Promise<AuthorizedOutboundFile> {
  let handle: OutboundFileHandle;
  try {
    handle = await fileSystem.open(canonicalPath, OUTBOUND_FILE_OPEN_FLAGS);
  } catch (error) {
    throw openedFileFailure(error);
  }

  try {
    const openedSnapshot = await handle.stat();
    if (!openedSnapshot.isFile()) {
      throw runtimeFileError(
        "INVALID_ARGUMENT",
        "The opened outbound target is not a regular file.",
      );
    }
    if (!sameFileSnapshot(snapshot, openedSnapshot)) {
      throw runtimeFileError("UNAUTHORIZED", "The outbound file changed during authorization.");
    }
    if (openedSnapshot.nlink !== 1) {
      throw runtimeFileError("UNAUTHORIZED", "Hard-linked files cannot be attached.");
    }
    if (openedSnapshot.size > maximumBytes) {
      throw runtimeFileError(
        "INVALID_ARGUMENT",
        "The outbound file exceeds the configured byte limit.",
      );
    }
    let actualPath: string;
    try {
      actualPath = await descriptorPathResolver.resolve(handle.fd);
      if (!isSafeAbsolutePath(actualPath) || resolve(actualPath) !== actualPath) {
        throw runtimeFileError("UNAUTHORIZED", "The retained outbound file path is unsafe.");
      }
      assertAllowedPath(actualPath);
    } catch (error) {
      if (error instanceof BridgeError && error.code === "UNAUTHORIZED") {
        throw error;
      }
      throw runtimeFileError(
        "UNAUTHORIZED",
        "The retained outbound file path could not be validated.",
      );
    }
    return new RetainedAuthorizedOutboundFile(
      actualPath,
      openedSnapshot.size,
      { dev: openedSnapshot.dev, ino: openedSnapshot.ino },
      handle,
    );
  } catch (error) {
    const primary = openedFileFailure(error);
    try {
      await handle.close();
    } catch {
      throw withSafeCloseFailure(primary);
    }
    throw primary;
  }
}

export async function prepareOutboundFileValidation(
  context: OutboundFileValidationContext,
): Promise<PreparedOutboundFileValidation> {
  const maximumBytes = configuredMaxFileBytes(context.maxFileBytes);
  const fileSystem = context.fileSystem ?? defaultOutboundFileSystem;
  const descriptorPathResolver = context.descriptorPathResolver ?? defaultDescriptorPathResolver;
  const workspace = context.workspace;
  const bridgePaths = parseBridgePaths(workspace.bridgePaths);
  const bridge = await canonicalBridgePaths(bridgePaths, fileSystem);
  const approvedRoots = unique([workspace.cwd, ...workspace.configuredRuntimeWorkspaceRoots]);
  const revalidatedRoots = await Promise.all(
    approvedRoots.map((root) => revalidateApprovedDirectory(root, fileSystem)),
  );
  const currentInbox = await revalidateApprovedDirectory(workspace.instanceInbox, fileSystem);
  if (directInstanceId(bridge.inboxDirectory, currentInbox) === undefined) {
    throw runtimeFileError("UNAUTHORIZED", "The current instance inbox is no longer isolated.");
  }
  for (const root of revalidatedRoots) {
    if (bridge.hardProtectedPaths.some((protectedPath) => pathsOverlap(root, protectedPath))) {
      throw runtimeFileError("UNAUTHORIZED", "An approved file root overlaps hard bridge state.");
    }
    if (bridge.containerProtectedPaths.some((protectedPath) => pathsOverlap(root, protectedPath))) {
      throw runtimeFileError("UNAUTHORIZED", "An approved file root overlaps bridge state.");
    }
  }
  if (
    bridge.hardProtectedPaths.some((protectedPath) => containsPath(protectedPath, currentInbox))
  ) {
    throw runtimeFileError(
      "UNAUTHORIZED",
      "The current instance inbox overlaps hard bridge state.",
    );
  }

  const assertAllowedPath = (canonical: string): void => {
    if (bridge.hardProtectedPaths.some((protectedPath) => containsPath(protectedPath, canonical))) {
      throw runtimeFileError("UNAUTHORIZED", "Hard protected bridge state cannot be attached.");
    }
    if (containsPath(currentInbox, canonical)) {
      return;
    }
    if (
      bridge.containerProtectedPaths.some((protectedPath) => containsPath(protectedPath, canonical))
    ) {
      throw runtimeFileError("UNAUTHORIZED", "Protected bridge state cannot be attached.");
    }
    if (!revalidatedRoots.some((root) => containsPath(root, canonical))) {
      throw runtimeFileError("UNAUTHORIZED", "The outbound file is outside approved roots.");
    }
  };

  return Object.freeze({
    authorize: async (pathInput: unknown) => {
      if (typeof pathInput !== "string" || !isSafeAbsolutePath(pathInput)) {
        throw runtimeFileError("INVALID_ARGUMENT", "The outbound file path must be absolute.");
      }
      const canonical = await canonicalOutboundPath(pathInput, fileSystem);
      assertAllowedPath(canonical);
      const snapshot = await snapshotOutboundFile(canonical, fileSystem);
      return openAuthorizedOutboundFile(
        canonical,
        snapshot,
        maximumBytes,
        fileSystem,
        descriptorPathResolver,
        assertAllowedPath,
      );
    },
  });
}

export async function validateOutboundFile(
  pathInput: unknown,
  context: OutboundFileValidationContext,
): Promise<AuthorizedOutboundFile> {
  const prepared = await prepareOutboundFileValidation(context);
  return prepared.authorize(pathInput);
}
