import { createHash } from "node:crypto";
import { z } from "zod";
import { resolveStatePaths } from "../config/paths.js";
import { BridgeError } from "../domain/errors.js";
import {
  type AccessPolicy,
  AccessPolicySchema,
  type AgentBinding,
  AgentBindingSchema,
  type AgentModelSettings,
  AgentModelSettingsSchema,
  type BotCredentialMetadata,
  BotCredentialMetadataSchema,
  type BotCredentialState,
  type DesiredBindingState,
  DesiredBindingStateSchema,
  DiscordSnowflakeSchema,
  IdentifierSchema,
  NameSchema,
  type ObservedBindingState,
  ObservedBindingStateSchema,
  PairingCodeSchema,
  type RegistryDocument,
  RegistryDocumentSchema,
  ThreadIdSchema,
  type WorkspaceProfile,
  WorkspaceProfileSchema,
} from "../domain/schemas.js";
import {
  type AtomicJsonEventObserver,
  AtomicJsonStore,
  type AtomicLockAdapter,
  type AtomicWriteFaultInjector,
} from "./atomic-json.js";

const CreateBindingInputSchema = AgentBindingSchema.pick({
  id: true,
  name: true,
  botName: true,
  threadId: true,
  workspace: true,
  tmuxSession: true,
}).strict();

const SetOwnerInputSchema = z
  .object({
    ownerUserId: DiscordSnowflakeSchema,
    confirmed: z.boolean(),
  })
  .strict();

const RegistryPathInputSchema = z
  .string()
  .min(1)
  .refine((value) => !value.includes("\0"), "Path must not contain NUL bytes");
const AccessPolicyRevisionSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, "Expected a lowercase SHA-256 revision");

const RegistryStoreOptionsSchema = z
  .object({
    registryPath: RegistryPathInputSchema.optional(),
    stateRoot: RegistryPathInputSchema.optional(),
    now: z.custom<() => Date>((value) => typeof value === "function").optional(),
    faultInjector: z
      .custom<AtomicWriteFaultInjector>((value) => typeof value === "function")
      .optional(),
    eventObserver: z
      .custom<AtomicJsonEventObserver>((value) => typeof value === "function")
      .optional(),
    lockAdapter: z.custom<AtomicLockAdapter>((value) => typeof value === "function").optional(),
  })
  .strict();

export type CreateBindingInput = z.infer<typeof CreateBindingInputSchema>;
export type SetOwnerInput = z.infer<typeof SetOwnerInputSchema>;

export interface RegistryStoreOptions {
  registryPath?: string;
  stateRoot?: string;
  now?: () => Date;
  faultInjector?: AtomicWriteFaultInjector;
  eventObserver?: AtomicJsonEventObserver;
  lockAdapter?: AtomicLockAdapter;
}

function emptyRegistry(): RegistryDocument {
  return {
    version: 1,
    bots: {},
    access: {},
    workspaces: {},
    bindings: {},
  };
}

function defaultAccessPolicy(ownerUserId: string): AccessPolicy {
  return {
    dmPolicy: "pairing",
    allowFrom: [ownerUserId],
    groups: {},
    pendingPairings: {},
    mentionPatterns: [],
    ackReaction: "\u2705",
    replyToMode: "first",
    textChunkLimit: 2_000,
    chunkMode: "length",
  };
}

function invalidArgument(label: string, error: z.ZodError): BridgeError {
  return new BridgeError(
    "INVALID_ARGUMENT",
    `Invalid ${label}`,
    "Correct the supplied value and retry.",
    { cause: error },
  );
}

function parseInput<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw invalidArgument(label, result.error);
  }
  return result.data;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }

  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(Reflect.get(value, key))}`)
    .join(",")}}`;
}

function revisionForValidatedPolicy(policy: AccessPolicy): string {
  return createHash("sha256").update(canonicalJson(policy)).digest("hex");
}

export function accessPolicyRevision(policy: AccessPolicy): string {
  return revisionForValidatedPolicy(parseInput(AccessPolicySchema, policy, "access policy"));
}

function notFound(resource: string, identity: string): BridgeError {
  return new BridgeError("NOT_FOUND", `${resource} not found: ${identity}`);
}

function conflict(message: string): BridgeError {
  return new BridgeError("CONFLICT", message);
}

function appendUnique(values: readonly string[], value: string): string[] {
  return values.includes(value) ? [...values] : [...values, value];
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function ownValue<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function botStateForObservedState(state: ObservedBindingState): BotCredentialState {
  switch (state) {
    case "stopped":
    case "starting":
      return "bound";
    case "failed":
      return "failed";
    case "running":
    case "stopping":
      return "running";
  }
}

export class RegistryStore {
  readonly registryPath: string;

  readonly #store: AtomicJsonStore<RegistryDocument>;
  readonly #now: () => Date;

  constructor(options: RegistryStoreOptions = {}) {
    const parsedOptions = parseInput(RegistryStoreOptionsSchema, options, "registry store options");
    if (parsedOptions.registryPath !== undefined && parsedOptions.stateRoot !== undefined) {
      throw new BridgeError(
        "INVALID_ARGUMENT",
        "Specify either registryPath or stateRoot, not both",
      );
    }

    this.registryPath =
      parsedOptions.registryPath ?? resolveStatePaths(parsedOptions.stateRoot).registryPath;
    this.#now = parsedOptions.now ?? (() => new Date());
    this.#store = new AtomicJsonStore({
      filePath: this.registryPath,
      schema: RegistryDocumentSchema,
      initialDocument: emptyRegistry,
      ...(parsedOptions.faultInjector === undefined
        ? {}
        : { faultInjector: parsedOptions.faultInjector }),
      ...(parsedOptions.eventObserver === undefined
        ? {}
        : { eventObserver: parsedOptions.eventObserver }),
      ...(parsedOptions.lockAdapter === undefined
        ? {}
        : { lockAdapter: parsedOptions.lockAdapter }),
    });
  }

  async read(): Promise<RegistryDocument> {
    return this.#store.read();
  }

  async registerBot(metadata: BotCredentialMetadata): Promise<BotCredentialMetadata> {
    const bot = parseInput(BotCredentialMetadataSchema, metadata, "bot credential metadata");
    if (bot.state !== "registering" && bot.state !== "registered") {
      throw new BridgeError(
        "INVALID_ARGUMENT",
        "New bot credentials must be registering or registered",
      );
    }

    return this.#store.transact((document) => {
      if (Object.hasOwn(document.bots, bot.name)) {
        throw conflict(`Bot name is already registered: ${bot.name}`);
      }

      for (const existing of Object.values(document.bots)) {
        if (existing.applicationId === bot.applicationId) {
          throw conflict(`Discord application ID is already registered: ${bot.applicationId}`);
        }
        if (existing.botUserId === bot.botUserId) {
          throw conflict(`Discord bot user ID is already registered: ${bot.botUserId}`);
        }
        if (existing.keychainAccount === bot.keychainAccount) {
          throw conflict(`Keychain account is already registered: ${bot.keychainAccount}`);
        }
      }

      const next: RegistryDocument = {
        ...document,
        bots: { ...document.bots, [bot.name]: bot },
        access: {
          ...document.access,
          [bot.name]: defaultAccessPolicy(bot.ownerUserId),
        },
      };
      return { document: next, result: bot };
    });
  }

  async addWorkspace(profile: WorkspaceProfile): Promise<WorkspaceProfile> {
    const workspace = parseInput(WorkspaceProfileSchema, profile, "workspace profile");

    return this.#store.transact((document) => {
      if (Object.hasOwn(document.workspaces, workspace.name)) {
        throw conflict(`Workspace already exists: ${workspace.name}`);
      }
      return {
        document: {
          ...document,
          workspaces: { ...document.workspaces, [workspace.name]: workspace },
        },
        result: workspace,
      };
    });
  }

  async createBinding(input: CreateBindingInput): Promise<AgentBinding> {
    const requested = parseInput(CreateBindingInputSchema, input, "binding");

    return this.#store.transact((document) => {
      const bot = ownValue(document.bots, requested.botName);
      if (bot === undefined) {
        throw notFound("Bot", requested.botName);
      }
      if (bot.state !== "registered") {
        throw conflict(`Bot ${requested.botName} is not available for binding (${bot.state})`);
      }
      if (!Object.hasOwn(document.workspaces, requested.workspace)) {
        throw notFound("Workspace", requested.workspace);
      }

      for (const existing of Object.values(document.bindings)) {
        if (existing.id === requested.id) {
          throw conflict(`Binding ID is already reserved: ${requested.id}`);
        }
        if (existing.name === requested.name) {
          throw conflict(`Binding name is already reserved: ${requested.name}`);
        }
        if (existing.botName === requested.botName) {
          throw conflict(`Bot is already reserved: ${requested.botName}`);
        }
        if (existing.threadId === requested.threadId) {
          throw conflict(`Codex thread is already reserved: ${requested.threadId}`);
        }
        if (existing.tmuxSession === requested.tmuxSession) {
          throw conflict(`tmux session is already reserved: ${requested.tmuxSession}`);
        }
      }

      const timestamp = this.#timestamp();
      const binding: AgentBinding = {
        ...requested,
        previousThreadIds: [],
        desiredState: "stopped",
        observedState: "stopped",
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const updatedBot: BotCredentialMetadata = { ...bot, state: "bound" };

      return {
        document: {
          ...document,
          bots: { ...document.bots, [bot.name]: updatedBot },
          bindings: { ...document.bindings, [binding.id]: binding },
        },
        result: binding,
      };
    });
  }

  async replaceThread(bindingId: string, threadId: string): Promise<AgentBinding> {
    const parsedBindingId = parseInput(IdentifierSchema, bindingId, "binding ID");
    const parsedThreadId = parseInput(ThreadIdSchema, threadId, "thread ID");

    return this.#store.transact((document) => {
      const binding = ownValue(document.bindings, parsedBindingId);
      if (binding === undefined) {
        throw notFound("Binding", parsedBindingId);
      }
      if (binding.threadId === parsedThreadId) {
        throw conflict(`Binding already uses Codex thread: ${parsedThreadId}`);
      }

      for (const existing of Object.values(document.bindings)) {
        if (existing.id !== parsedBindingId && existing.threadId === parsedThreadId) {
          throw conflict(`Codex thread is already reserved: ${parsedThreadId}`);
        }
      }

      const updated: AgentBinding = {
        ...binding,
        threadId: parsedThreadId,
        previousThreadIds: [...binding.previousThreadIds, binding.threadId],
        updatedAt: this.#timestamp(),
      };

      return {
        document: {
          ...document,
          bindings: { ...document.bindings, [updated.id]: updated },
        },
        result: updated,
      };
    });
  }

  async updateModelSettings(
    bindingId: string,
    settings: AgentModelSettings,
  ): Promise<AgentBinding> {
    const parsedBindingId = parseInput(IdentifierSchema, bindingId, "binding ID");
    const parsedSettings = parseInput(AgentModelSettingsSchema, settings, "model settings");

    return this.#store.transact((document) => {
      const binding = ownValue(document.bindings, parsedBindingId);
      if (binding === undefined) {
        throw notFound("Binding", parsedBindingId);
      }

      const { modelId: _modelId, reasoningEffort: _reasoningEffort, ...base } = binding;
      const updated: AgentBinding = {
        ...base,
        ...(parsedSettings.modelId === undefined ? {} : { modelId: parsedSettings.modelId }),
        ...(parsedSettings.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: parsedSettings.reasoningEffort }),
        updatedAt: this.#timestamp(),
      };

      return {
        document: {
          ...document,
          bindings: { ...document.bindings, [updated.id]: updated },
        },
        result: updated,
      };
    });
  }

  async markObservedState(bindingId: string, state: ObservedBindingState): Promise<AgentBinding> {
    const parsedBindingId = parseInput(IdentifierSchema, bindingId, "binding ID");
    const observedState = parseInput(ObservedBindingStateSchema, state, "observed binding state");

    return this.#store.transact((document) => {
      const binding = ownValue(document.bindings, parsedBindingId);
      if (binding === undefined) {
        throw notFound("Binding", parsedBindingId);
      }
      const bot = ownValue(document.bots, binding.botName);
      if (bot === undefined) {
        throw new BridgeError(
          "CONFIGURATION",
          `Binding ${binding.id} references missing bot ${binding.botName}`,
        );
      }

      const updatedBinding: AgentBinding = {
        ...binding,
        observedState,
        updatedAt: this.#timestamp(),
      };
      const updatedBot: BotCredentialMetadata = {
        ...bot,
        state: botStateForObservedState(observedState),
      };

      return {
        document: {
          ...document,
          bots: { ...document.bots, [bot.name]: updatedBot },
          bindings: {
            ...document.bindings,
            [updatedBinding.id]: updatedBinding,
          },
        },
        result: updatedBinding,
      };
    });
  }

  async setDesiredState(bindingId: string, state: DesiredBindingState): Promise<AgentBinding> {
    const parsedBindingId = parseInput(IdentifierSchema, bindingId, "binding ID");
    const desiredState = parseInput(DesiredBindingStateSchema, state, "desired binding state");

    return this.#store.transact((document) => {
      const binding = ownValue(document.bindings, parsedBindingId);
      if (binding === undefined) {
        throw notFound("Binding", parsedBindingId);
      }

      const updated: AgentBinding = {
        ...binding,
        desiredState,
        updatedAt: this.#timestamp(),
      };
      return {
        document: {
          ...document,
          bindings: { ...document.bindings, [updated.id]: updated },
        },
        result: updated,
      };
    });
  }

  async updateAccess(
    botName: string,
    expectedRevision: string,
    nextPolicy: AccessPolicy,
  ): Promise<AccessPolicy> {
    const parsedBotName = parseInput(NameSchema, botName, "bot name");
    const revision = parseInput(
      AccessPolicyRevisionSchema,
      expectedRevision,
      "access policy revision",
    );

    return this.#store.transact((document) => {
      const bot = ownValue(document.bots, parsedBotName);
      if (bot === undefined) {
        throw notFound("Bot", parsedBotName);
      }
      const access = ownValue(document.access, parsedBotName);
      if (access === undefined) {
        throw new BridgeError("CONFIGURATION", `Bot ${parsedBotName} has no access policy`);
      }
      if (revisionForValidatedPolicy(access) !== revision) {
        throw conflict(`Access policy changed since revision ${revision}`);
      }

      const requested = parseInput(AccessPolicySchema, nextPolicy, "access policy update");
      // The owner's single allowFrom entry is always the automatic effective-owner grant.
      const updated = AccessPolicySchema.parse({
        ...requested,
        allowFrom: appendUnique(requested.allowFrom, bot.ownerUserId),
      });
      return {
        document: {
          ...document,
          access: { ...document.access, [parsedBotName]: updated },
        },
        result: updated,
      };
    });
  }

  async approvePairing(botName: string, code: string): Promise<AccessPolicy> {
    const parsedBotName = parseInput(NameSchema, botName, "bot name");
    const pairingCode = parseInput(PairingCodeSchema, code, "pairing code");

    return this.#store.transact((document) => {
      if (!Object.hasOwn(document.bots, parsedBotName)) {
        throw notFound("Bot", parsedBotName);
      }
      const access = ownValue(document.access, parsedBotName);
      if (access === undefined) {
        throw new BridgeError("CONFIGURATION", `Bot ${parsedBotName} has no access policy`);
      }
      const pairing = ownValue(access.pendingPairings, pairingCode);
      if (pairing === undefined) {
        throw notFound("Pairing code", pairingCode);
      }
      if (Date.parse(pairing.expiresAt) <= this.#now().getTime()) {
        throw conflict(`Pairing code has expired: ${pairingCode}`);
      }

      const pendingPairings = { ...access.pendingPairings };
      delete pendingPairings[pairingCode];
      const updated: AccessPolicy = {
        ...access,
        allowFrom: appendUnique(unique(access.allowFrom), pairing.senderId),
        pendingPairings,
      };

      return {
        document: {
          ...document,
          access: { ...document.access, [parsedBotName]: updated },
        },
        result: updated,
      };
    });
  }

  async confirmOwner(botName: string, ownerUserId: string): Promise<BotCredentialMetadata> {
    const parsedBotName = parseInput(NameSchema, botName, "bot name");
    const parsedOwnerUserId = parseInput(
      DiscordSnowflakeSchema,
      ownerUserId,
      "owner Discord user ID",
    );

    return this.#store.transact((document) => {
      const bot = ownValue(document.bots, parsedBotName);
      if (bot === undefined) {
        throw notFound("Bot", parsedBotName);
      }
      if (bot.ownerUserId !== parsedOwnerUserId) {
        throw new BridgeError("UNAUTHORIZED", "Only the configured owner can confirm ownership.");
      }
      if (bot.ownerConfirmedAt !== undefined) {
        return { document, result: bot };
      }
      const updated: BotCredentialMetadata = {
        ...bot,
        ownerConfirmedAt: this.#timestamp(),
      };
      return {
        document: {
          ...document,
          bots: { ...document.bots, [parsedBotName]: updated },
        },
        result: updated,
      };
    });
  }

  async setOwner(botName: string, input: SetOwnerInput): Promise<BotCredentialMetadata> {
    const parsedBotName = parseInput(NameSchema, botName, "bot name");
    const requested = parseInput(SetOwnerInputSchema, input, "owner transfer");

    return this.#store.transact((document) => {
      const bot = ownValue(document.bots, parsedBotName);
      if (bot === undefined) {
        throw notFound("Bot", parsedBotName);
      }
      if (!requested.confirmed) {
        throw conflict("Owner transfer requires explicit confirmation");
      }
      if (
        Object.values(document.bindings).some(
          (binding) =>
            binding.botName === parsedBotName &&
            (binding.desiredState !== "stopped" || binding.observedState !== "stopped"),
        )
      ) {
        throw conflict(`Every binding for bot ${parsedBotName} must be stopped`);
      }
      const access = ownValue(document.access, parsedBotName);
      if (access === undefined) {
        throw new BridgeError("CONFIGURATION", `Bot ${parsedBotName} has no access policy`);
      }

      const updatedBot: BotCredentialMetadata = {
        ...bot,
        ownerUserId: requested.ownerUserId,
      };
      delete updatedBot.ownerConfirmedAt;

      const oldOwnerIndex = access.allowFrom.indexOf(bot.ownerUserId);
      if (oldOwnerIndex < 0) {
        throw new BridgeError(
          "CONFIGURATION",
          `Bot owner ${bot.ownerUserId} is missing from the automatic allowlist`,
        );
      }
      const preservedAllowlist = [
        ...access.allowFrom.slice(0, oldOwnerIndex),
        ...access.allowFrom.slice(oldOwnerIndex + 1),
      ];
      const updatedAccess: AccessPolicy = {
        ...access,
        allowFrom: appendUnique(preservedAllowlist, requested.ownerUserId),
      };

      return {
        document: {
          ...document,
          bots: { ...document.bots, [parsedBotName]: updatedBot },
          access: { ...document.access, [parsedBotName]: updatedAccess },
        },
        result: updatedBot,
      };
    });
  }

  async unlink(bindingId: string): Promise<AgentBinding> {
    const parsedBindingId = parseInput(IdentifierSchema, bindingId, "binding ID");

    return this.#store.transact((document) => {
      const binding = ownValue(document.bindings, parsedBindingId);
      if (binding === undefined) {
        throw notFound("Binding", parsedBindingId);
      }
      if (binding.desiredState !== "stopped" || binding.observedState !== "stopped") {
        throw conflict(`Binding ${binding.name} must be stopped before unlink`);
      }
      const bot = ownValue(document.bots, binding.botName);
      if (bot === undefined) {
        throw new BridgeError(
          "CONFIGURATION",
          `Binding ${binding.id} references missing bot ${binding.botName}`,
        );
      }

      const bindings = { ...document.bindings };
      delete bindings[parsedBindingId];
      const updatedBot: BotCredentialMetadata = { ...bot, state: "registered" };

      return {
        document: {
          ...document,
          bots: { ...document.bots, [bot.name]: updatedBot },
          bindings,
        },
        result: binding,
      };
    });
  }

  async beginBotRemoval(botName: string): Promise<BotCredentialMetadata> {
    const parsedBotName = parseInput(NameSchema, botName, "bot name");

    return this.#store.transact((document) => {
      const bot = ownValue(document.bots, parsedBotName);
      if (bot === undefined) {
        throw notFound("Bot", parsedBotName);
      }
      if (Object.values(document.bindings).some((binding) => binding.botName === parsedBotName)) {
        throw conflict(`Bot ${parsedBotName} is still referenced by a binding`);
      }
      if (bot.state === "deleting") {
        throw conflict(`Bot removal has already started: ${parsedBotName}`);
      }

      const updated: BotCredentialMetadata = { ...bot, state: "deleting" };
      return {
        document: {
          ...document,
          bots: { ...document.bots, [parsedBotName]: updated },
        },
        result: updated,
      };
    });
  }

  async finishBotRemoval(botName: string): Promise<BotCredentialMetadata> {
    const parsedBotName = parseInput(NameSchema, botName, "bot name");

    return this.#store.transact((document) => {
      const bot = ownValue(document.bots, parsedBotName);
      if (bot === undefined) {
        throw notFound("Bot", parsedBotName);
      }
      if (bot.state !== "deleting") {
        throw conflict(`Bot removal has not started: ${parsedBotName}`);
      }
      if (Object.values(document.bindings).some((binding) => binding.botName === parsedBotName)) {
        throw conflict(`Bot ${parsedBotName} is still referenced by a binding`);
      }

      const bots = { ...document.bots };
      const access = { ...document.access };
      delete bots[parsedBotName];
      delete access[parsedBotName];
      return {
        document: { ...document, bots, access },
        result: bot,
      };
    });
  }

  async updateWorkspace(
    workspaceName: string,
    profile: WorkspaceProfile,
  ): Promise<WorkspaceProfile> {
    const parsedName = parseInput(NameSchema, workspaceName, "workspace name");
    const workspace = parseInput(WorkspaceProfileSchema, profile, "workspace profile");
    if (workspace.name !== parsedName) {
      throw new BridgeError(
        "INVALID_ARGUMENT",
        `Workspace name ${workspace.name} does not match target ${parsedName}`,
      );
    }

    return this.#store.transact((document) => {
      if (!Object.hasOwn(document.workspaces, parsedName)) {
        throw notFound("Workspace", parsedName);
      }
      if (
        Object.values(document.bindings).some(
          (binding) =>
            binding.workspace === parsedName &&
            (binding.desiredState !== "stopped" || binding.observedState !== "stopped"),
        )
      ) {
        throw conflict(`Every binding for workspace ${parsedName} must be stopped`);
      }

      return {
        document: {
          ...document,
          workspaces: { ...document.workspaces, [parsedName]: workspace },
        },
        result: workspace,
      };
    });
  }

  async removeWorkspace(workspaceName: string): Promise<WorkspaceProfile> {
    const parsedName = parseInput(NameSchema, workspaceName, "workspace name");

    return this.#store.transact((document) => {
      const workspace = ownValue(document.workspaces, parsedName);
      if (workspace === undefined) {
        throw notFound("Workspace", parsedName);
      }
      if (Object.values(document.bindings).some((binding) => binding.workspace === parsedName)) {
        throw conflict(`Workspace ${parsedName} is still referenced; unlink its bindings first`);
      }

      const workspaces = { ...document.workspaces };
      delete workspaces[parsedName];
      return {
        document: { ...document, workspaces },
        result: workspace,
      };
    });
  }

  #timestamp(): string {
    return this.#now().toISOString();
  }
}
