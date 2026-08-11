import { randomUUID } from "node:crypto";
import { mkdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { CodexAppServerProcess } from "../app-server/process.js";
import { CodexSessionService } from "../app-server/session.js";
import { AtomicThreadCreationJournal } from "../app-server/thread-creation-journal.js";
import { ensureStateDirectories, resolveStatePaths, type StatePaths } from "../config/paths.js";
import { registerApplicationCommands, verifyBotToken } from "../discord/api.js";
import { AtomicProgressObservationJournal } from "../discord/progress-journal.js";
import { BridgeError } from "../domain/errors.js";
import type {
  AccessPolicy,
  AgentBinding,
  BotCredentialMetadata,
  WorkspaceProfile,
} from "../domain/schemas.js";
import { DiscordSnowflakeSchema, NameSchema } from "../domain/schemas.js";
import { createDefaultCredentialStore } from "../secrets/platform.js";
import { accessPolicyRevision, RegistryStore } from "../storage/registry.js";
import { DEFAULT_SUPERVISOR_PATH, TmuxController } from "./tmux.js";
import { WorkspaceNormalizer } from "./workspaces.js";

export interface ManagerKeychainPort {
  get(account: string): Promise<string>;
  set(account: string, token: string): Promise<void>;
  delete(account: string): Promise<void>;
}

export interface ManagerDiscordPort {
  verify(token: string): Promise<{ applicationId: string; botUserId: string }>;
  registerCommands(applicationId: string, token: string): Promise<unknown>;
}

export interface ManagerThreadPort {
  create(
    workspace: WorkspaceProfile,
    inbox: string,
    creationKey: string,
  ): Promise<{ threadId: string }>;
  read(threadId: string): Promise<{ id: string; cwd: string }>;
}

export interface ManagerTmuxPort {
  start(instanceId: string, session: string): Promise<void>;
  stop(session: string, options?: { force?: boolean }): Promise<void>;
  hasSession(session: string): Promise<boolean>;
}

export interface ManagerServiceOptions {
  readonly registry: RegistryStore;
  readonly keychain: ManagerKeychainPort;
  readonly discord: ManagerDiscordPort;
  readonly threads: ManagerThreadPort;
  readonly tmux: ManagerTmuxPort;
  readonly paths: StatePaths;
  readonly createId?: () => string;
}

export interface RegisterBotInput {
  readonly name: string;
  readonly ownerUserId: string;
  readonly token: string;
}

export interface CreateAgentInput {
  readonly botName: string;
  readonly workspaceName: string;
  readonly name?: string;
}

export type ProvisionWorkspace =
  | { readonly kind: "existing"; readonly name: string }
  | { readonly cwd: string; readonly kind: "cwd" };

export interface ProvisionAgentInput {
  readonly botName: string;
  readonly channelIds: readonly string[];
  readonly name?: string;
  readonly ownerUserId: string;
  readonly requireMention: boolean;
  readonly token: string;
  readonly workspace: ProvisionWorkspace;
}

export interface ProvisionAgentResult {
  readonly access: AccessPolicy;
  readonly binding: AgentBinding;
  readonly bot: BotCredentialMetadata;
  readonly channelIds: readonly string[];
  readonly workspace: WorkspaceProfile;
}

export interface LinkAgentInput extends CreateAgentInput {
  readonly threadId: string;
  readonly start?: boolean;
}

export interface ProgressReconciliationRequest {
  readonly agentId: string;
  readonly agentName: string;
  readonly reconciliationRequested: true;
  readonly restartRequired: true;
  readonly threadId: string;
}

export interface RestoredAgent {
  readonly id: string;
  readonly name: string;
  readonly tmuxSession: string;
}

export interface RestoreRunningAgentsResult {
  readonly alreadyRunning: readonly RestoredAgent[];
  readonly started: readonly RestoredAgent[];
}

function ownValue<T>(record: Record<string, T>, key: string, label: string): T {
  const value = Object.hasOwn(record, key) ? record[key] : undefined;
  if (value === undefined) throw new BridgeError("NOT_FOUND", `${label} not found: ${key}`);
  return value;
}

function provisionName(value: unknown, label: string): string {
  const parsed = NameSchema.safeParse(value);
  if (!parsed.success) {
    throw new BridgeError("INVALID_ARGUMENT", `Invalid provisioning ${label}.`);
  }
  return parsed.data;
}

function provisionSnowflake(value: unknown, label: string): string {
  const parsed = DiscordSnowflakeSchema.safeParse(value);
  if (!parsed.success) {
    throw new BridgeError("INVALID_ARGUMENT", `Invalid provisioning ${label}.`);
  }
  return parsed.data;
}

function provisionChannels(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new BridgeError("INVALID_ARGUMENT", "Provisioning requires at least one channel.");
  }
  const channels = value.map((entry) => provisionSnowflake(entry, "channel ID"));
  if (new Set(channels).size !== channels.length) {
    throw new BridgeError("INVALID_ARGUMENT", "Provisioning channel IDs must be unique.");
  }
  return Object.freeze(channels);
}

async function provisionDirectory(value: unknown): Promise<string> {
  if (typeof value !== "string" || !isAbsolute(value)) {
    throw new BridgeError(
      "INVALID_ARGUMENT",
      "Provisioning cwd must be an existing absolute directory.",
    );
  }
  try {
    const canonical = await realpath(value);
    if (!(await stat(canonical)).isDirectory()) {
      throw new BridgeError(
        "INVALID_ARGUMENT",
        "Provisioning cwd must be an existing absolute directory.",
      );
    }
    return canonical;
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError(
      "INVALID_ARGUMENT",
      "Provisioning cwd must be an existing absolute directory.",
    );
  }
}

function defaultBindingName(botName: string): string {
  return `${botName}-agent`;
}

function tmuxSession(instanceId: string): string {
  return `codex-discord-${instanceId.slice(0, 8)}`;
}

function restoredAgent(binding: AgentBinding): RestoredAgent {
  return Object.freeze({
    id: binding.id,
    name: binding.name,
    tmuxSession: binding.tmuxSession,
  });
}

export class ManagerService {
  private readonly options: ManagerServiceOptions;
  private readonly createId: () => string;

  constructor(options: ManagerServiceOptions) {
    this.options = options;
    this.createId = options.createId ?? randomUUID;
  }

  async registerBot(input: RegisterBotInput): Promise<BotCredentialMetadata> {
    const identity = await this.options.discord.verify(input.token);
    const current = await this.options.registry.read();
    if (Object.hasOwn(current.bots, input.name)) {
      throw new BridgeError("CONFLICT", `Bot name is already registered: ${input.name}`);
    }
    await this.options.discord.registerCommands(identity.applicationId, input.token);
    await this.options.keychain.set(input.name, input.token);
    try {
      return await this.options.registry.registerBot({
        name: input.name,
        applicationId: identity.applicationId,
        botUserId: identity.botUserId,
        keychainAccount: input.name,
        ownerUserId: input.ownerUserId,
        state: "registered",
      });
    } catch (error) {
      await this.options.keychain.delete(input.name).catch(() => undefined);
      throw error;
    }
  }

  async listBots(): Promise<readonly BotCredentialMetadata[]> {
    return Object.values((await this.options.registry.read()).bots);
  }

  async registerBotCommands(botName: string): Promise<unknown> {
    const bot = ownValue((await this.options.registry.read()).bots, botName, "Bot");
    const token = await this.options.keychain.get(bot.keychainAccount);
    return await this.options.discord.registerCommands(bot.applicationId, token);
  }

  async addWorkspace(profile: WorkspaceProfile): Promise<WorkspaceProfile> {
    return await this.options.registry.addWorkspace(profile);
  }

  async listWorkspaces(): Promise<readonly WorkspaceProfile[]> {
    return Object.values((await this.options.registry.read()).workspaces);
  }

  async createAgent(input: CreateAgentInput): Promise<AgentBinding> {
    const document = await this.options.registry.read();
    ownValue(document.bots, input.botName, "Bot");
    const workspace = ownValue(document.workspaces, input.workspaceName, "Workspace");
    const id = this.createId();
    const inbox = this.options.paths.instanceInboxDirectory(id);
    await mkdir(inbox, { mode: 0o700, recursive: true });
    const created = await this.options.threads.create(workspace, inbox, id);
    const binding = await this.options.registry.createBinding({
      id,
      name: input.name ?? defaultBindingName(input.botName),
      botName: input.botName,
      threadId: created.threadId,
      workspace: input.workspaceName,
      tmuxSession: tmuxSession(id),
    });
    await this.options.registry.setDesiredState(binding.id, "running");
    try {
      await this.options.tmux.start(binding.id, binding.tmuxSession);
    } catch (error) {
      await this.options.registry.markObservedState(binding.id, "failed").catch(() => undefined);
      throw new BridgeError(
        "RUNTIME",
        `Agent binding ${binding.id} was created but tmux did not start.`,
        `Retry start with the exact binding ID ${binding.id}.`,
        { cause: error },
      );
    }
    return ownValue((await this.options.registry.read()).bindings, binding.id, "Binding");
  }

  async linkAgent(input: LinkAgentInput): Promise<AgentBinding> {
    const document = await this.options.registry.read();
    ownValue(document.bots, input.botName, "Bot");
    ownValue(document.workspaces, input.workspaceName, "Workspace");
    await this.options.threads.read(input.threadId);
    const id = this.createId();
    await mkdir(this.options.paths.instanceInboxDirectory(id), { mode: 0o700, recursive: true });
    const binding = await this.options.registry.createBinding({
      id,
      name: input.name ?? defaultBindingName(input.botName),
      botName: input.botName,
      threadId: input.threadId,
      workspace: input.workspaceName,
      tmuxSession: tmuxSession(id),
    });
    if (input.start === true) return await this.start(binding.id);
    return binding;
  }

  async spawnForOwner(
    ownerUserId: string,
    botName: string,
    workspaceName: string,
  ): Promise<AgentBinding> {
    const bot = ownValue((await this.options.registry.read()).bots, botName, "Bot");
    if (bot.ownerUserId !== ownerUserId) {
      throw new BridgeError("UNAUTHORIZED", "The selected bot belongs to another owner.");
    }
    return await this.createAgent({ botName, workspaceName });
  }

  async provisionAgent(input: ProvisionAgentInput): Promise<ProvisionAgentResult> {
    const botName = provisionName(input.botName, "bot name");
    const ownerUserId = provisionSnowflake(input.ownerUserId, "owner Discord user ID");
    const channelIds = provisionChannels(input.channelIds);
    if (typeof input.requireMention !== "boolean") {
      throw new BridgeError("INVALID_ARGUMENT", "Invalid provisioning mention policy.");
    }
    const name = input.name === undefined ? undefined : provisionName(input.name, "agent name");
    const document = await this.options.registry.read();
    if (Object.hasOwn(document.bots, botName)) {
      throw new BridgeError("CONFLICT", `Bot name is already registered: ${botName}`);
    }

    let workspace: WorkspaceProfile;
    let workspaceCreated = false;
    if (input.workspace.kind === "existing") {
      const workspaceName = provisionName(input.workspace.name, "workspace name");
      workspace = ownValue(document.workspaces, workspaceName, "Workspace");
    } else if (input.workspace.kind === "cwd") {
      const workspaceName = `${botName}-workspace`;
      if (Object.hasOwn(document.workspaces, workspaceName)) {
        throw new BridgeError("CONFLICT", `Workspace already exists: ${workspaceName}`);
      }
      workspace = {
        name: workspaceName,
        cwd: await provisionDirectory(input.workspace.cwd),
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
        runtimeWorkspaceRoots: [],
      };
      workspace = await this.addWorkspace(workspace);
      workspaceCreated = true;
    } else {
      throw new BridgeError("INVALID_ARGUMENT", "Invalid provisioning workspace selector.");
    }

    let bot: BotCredentialMetadata;
    try {
      bot = await this.registerBot({ name: botName, ownerUserId, token: input.token });
    } catch (error) {
      if (!workspaceCreated) throw error;
      throw new BridgeError(
        error instanceof BridgeError ? error.code : "RUNTIME",
        `Bot registration failed after workspace ${workspace.name} was created.`,
        `Retry provision with \`--workspace ${workspace.name}\`.`,
        { cause: error },
      );
    }

    let access = await this.getAccess(botName);
    try {
      for (const channelId of channelIds) {
        access = await this.allowChannel(botName, channelId, input.requireMention);
      }
    } catch (error) {
      throw new BridgeError(
        error instanceof BridgeError ? error.code : "RUNTIME",
        `Channel setup failed after bot ${botName} was registered.`,
        `Finish channel access locally, then run \`node dist/cli.js create ${botName} --workspace ${workspace.name}${name === undefined ? "" : ` --name ${name}`}\`.`,
        { cause: error },
      );
    }

    let binding: AgentBinding;
    try {
      binding = await this.createAgent({
        botName,
        workspaceName: workspace.name,
        ...(name === undefined ? {} : { name }),
      });
    } catch (error) {
      if (error instanceof BridgeError && error.remediation !== undefined) throw error;
      throw new BridgeError(
        error instanceof BridgeError ? error.code : "RUNTIME",
        `Agent creation failed after bot ${botName} and its channels were configured.`,
        `Retry with \`node dist/cli.js create ${botName} --workspace ${workspace.name}${name === undefined ? "" : ` --name ${name}`}\`.`,
        { cause: error },
      );
    }

    return Object.freeze({
      access,
      binding,
      bot,
      channelIds,
      workspace,
    });
  }

  async start(target: string): Promise<AgentBinding> {
    const binding = await this.resolveBinding(target);
    await this.options.registry.setDesiredState(binding.id, "running");
    if (!(await this.options.tmux.hasSession(binding.tmuxSession))) {
      await this.options.tmux.start(binding.id, binding.tmuxSession);
    }
    return ownValue((await this.options.registry.read()).bindings, binding.id, "Binding");
  }

  async stop(target: string, force = false): Promise<AgentBinding> {
    const binding = await this.resolveBinding(target);
    await this.options.registry.setDesiredState(binding.id, "stopped");
    await this.options.tmux.stop(binding.tmuxSession, { force });
    if (force) await this.options.registry.markObservedState(binding.id, "stopped");
    return ownValue((await this.options.registry.read()).bindings, binding.id, "Binding");
  }

  async restart(target: string): Promise<AgentBinding> {
    const binding = await this.stop(target);
    return await this.start(binding.id);
  }

  async restoreRunningAgents(): Promise<RestoreRunningAgentsResult> {
    const desired = Object.values((await this.options.registry.read()).bindings)
      .filter((binding) => binding.desiredState === "running")
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    const alreadyRunning: RestoredAgent[] = [];
    const failed: string[] = [];
    const started: RestoredAgent[] = [];

    for (const binding of desired) {
      try {
        if (await this.options.tmux.hasSession(binding.tmuxSession)) {
          alreadyRunning.push(restoredAgent(binding));
          continue;
        }
        try {
          await this.options.tmux.start(binding.id, binding.tmuxSession);
        } catch (error) {
          if (await this.options.tmux.hasSession(binding.tmuxSession).catch(() => false)) {
            alreadyRunning.push(restoredAgent(binding));
            continue;
          }
          throw error;
        }
        started.push(restoredAgent(binding));
      } catch {
        failed.push(binding.id);
        await this.options.registry.markObservedState(binding.id, "failed").catch(() => undefined);
      }
    }

    if (failed.length > 0) {
      throw new BridgeError(
        "RUNTIME",
        `Unable to restore ${failed.length} desired agent${failed.length === 1 ? "" : "s"}.`,
        "Inspect `codex-discord status`, then rerun `codex-discord restore` after fixing tmux or runtime configuration.",
      );
    }
    return Object.freeze({
      alreadyRunning: Object.freeze(alreadyRunning),
      started: Object.freeze(started),
    });
  }

  async status(target?: string): Promise<unknown> {
    if (target === undefined) {
      const document = await this.options.registry.read();
      return await Promise.all(
        Object.values(document.bindings).map(async (binding) => ({
          ...binding,
          tmuxRunning: await this.options.tmux.hasSession(binding.tmuxSession),
        })),
      );
    }
    const binding = await this.resolveBinding(target);
    return {
      ...binding,
      tmuxRunning: await this.options.tmux.hasSession(binding.tmuxSession),
    };
  }

  async requestProgressReconciliation(
    target: string,
    threadId: string,
  ): Promise<ProgressReconciliationRequest> {
    const binding = await this.resolveBinding(target);
    const journal = new AtomicProgressObservationJournal({
      filePath: join(
        this.options.paths.instanceDirectory(binding.id),
        "progress-observations.json",
      ),
    });
    await journal.requestTombstoneReconciliation(threadId, new Date().toISOString());
    return Object.freeze({
      agentId: binding.id,
      agentName: binding.name,
      reconciliationRequested: true,
      restartRequired: true,
      threadId,
    });
  }

  async approvePairing(botName: string, code: string): Promise<AccessPolicy> {
    return await this.options.registry.approvePairing(botName, code);
  }

  async allowUser(botName: string, userId: string): Promise<AccessPolicy> {
    return await this.updateAccess(botName, (policy) => ({
      ...policy,
      allowFrom: policy.allowFrom.includes(userId)
        ? policy.allowFrom
        : [...policy.allowFrom, userId],
    }));
  }

  async allowChannel(
    botName: string,
    channelId: string,
    requireMention: boolean,
  ): Promise<AccessPolicy> {
    return await this.updateAccess(botName, (policy) => ({
      ...policy,
      groups: {
        ...policy.groups,
        [channelId]: { requireMention, allowFrom: [] },
      },
    }));
  }

  async getAccess(botName: string): Promise<AccessPolicy> {
    return ownValue((await this.options.registry.read()).access, botName, "Access policy");
  }

  private async updateAccess(
    botName: string,
    update: (policy: AccessPolicy) => AccessPolicy,
  ): Promise<AccessPolicy> {
    const policy = await this.getAccess(botName);
    return await this.options.registry.updateAccess(
      botName,
      accessPolicyRevision(policy),
      update(policy),
    );
  }

  private async resolveBinding(target: string): Promise<AgentBinding> {
    const bindings = (await this.options.registry.read()).bindings;
    if (Object.hasOwn(bindings, target)) return ownValue(bindings, target, "Binding");
    const matches = Object.values(bindings).filter((binding) => binding.name === target);
    if (matches.length !== 1 || matches[0] === undefined) {
      throw new BridgeError("NOT_FOUND", `Binding not found: ${target}`);
    }
    return matches[0];
  }
}

class ProductionManagerThreads implements ManagerThreadPort {
  private readonly workspaceNormalizer: WorkspaceNormalizer;
  private readonly journal: AtomicThreadCreationJournal;

  constructor(paths: StatePaths) {
    this.workspaceNormalizer = new WorkspaceNormalizer({
      bridgePaths: {
        root: paths.root,
        registryPath: paths.registryPath,
        logsDirectory: paths.logsDirectory,
        instancesDirectory: paths.instancesDirectory,
        inboxDirectory: paths.inboxDirectory,
        managerStatePaths: [paths.registryPath],
      },
    });
    this.journal = new AtomicThreadCreationJournal({
      filePath: join(paths.root, "manager-thread-creations.json"),
    });
  }

  async create(
    workspace: WorkspaceProfile,
    inbox: string,
    creationKey: string,
  ): Promise<{ threadId: string }> {
    return await this.withSession((session) => session.start(workspace, inbox, creationKey));
  }

  async read(threadId: string): Promise<{ id: string; cwd: string }> {
    return await this.withSession(async (session) => {
      const thread = await session.read(threadId);
      return { id: thread.id, cwd: thread.cwd };
    });
  }

  private async withSession<T>(
    operation: (session: CodexSessionService) => Promise<T>,
  ): Promise<T> {
    const process = new CodexAppServerProcess();
    try {
      const client = await process.start();
      await client.initialize("0.1.0");
      const session = new CodexSessionService({
        client,
        workspaceNormalizer: this.workspaceNormalizer,
        threadCreationJournal: this.journal,
      });
      return await operation(session);
    } finally {
      await process.stop().catch(() => undefined);
    }
  }
}

export async function createDefaultManagerService(
  paths = resolveStatePaths(process.env.CODEX_DISCORD_STATE_ROOT),
): Promise<ManagerService> {
  await ensureStateDirectories(paths);
  return new ManagerService({
    paths,
    registry: new RegistryStore({ registryPath: paths.registryPath }),
    keychain: createDefaultCredentialStore(),
    discord: {
      verify: (token) => verifyBotToken(token),
      registerCommands: (applicationId, token) => registerApplicationCommands(applicationId, token),
    },
    threads: new ProductionManagerThreads(paths),
    tmux: new TmuxController({ supervisorPath: DEFAULT_SUPERVISOR_PATH }),
  });
}
