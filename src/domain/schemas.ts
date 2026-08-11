import { z } from "zod";

export const NameSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Expected a lowercase slug");

export const DiscordSnowflakeSchema = z
  .string()
  .regex(/^[0-9]+$/, "Expected a decimal Discord snowflake");

export const IsoTimestampSchema = z.iso.datetime({ offset: true });
export const IdentifierSchema = z.uuid();
export const ThreadIdSchema = IdentifierSchema;
const UNSAFE_RECORD_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function boundedSetting(maxCodeUnits: number, maxUtf8Bytes: number) {
  return z
    .string()
    .min(1)
    .max(maxCodeUnits)
    .refine((value) => Buffer.byteLength(value, "utf8") <= maxUtf8Bytes)
    .refine((value) => {
      for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return false;
      }
      return true;
    }, "Control characters are not allowed")
    .refine((value) => value !== "default", "default is reserved for clearing an override");
}

export const ModelIdSchema = boundedSetting(256, 512);
export const ReasoningEffortSchema = boundedSetting(64, 128);

export const AgentModelSettingsSchema = z
  .object({
    modelId: ModelIdSchema.optional(),
    reasoningEffort: ReasoningEffortSchema.optional(),
  })
  .strict();

export const PairingCodeSchema = z
  .string()
  .min(1)
  .refine((value) => !UNSAFE_RECORD_KEYS.has(value), "Unsafe pairing code");

export const BotCredentialStateSchema = z.enum([
  "registering",
  "registered",
  "bound",
  "running",
  "failed",
  "deleting",
]);

export const DesiredBindingStateSchema = z.enum(["running", "stopped"]);
export const ObservedBindingStateSchema = z.enum([
  "stopped",
  "starting",
  "running",
  "stopping",
  "failed",
]);

export const BotCredentialMetadataSchema = z
  .object({
    name: NameSchema,
    applicationId: DiscordSnowflakeSchema,
    botUserId: DiscordSnowflakeSchema,
    keychainAccount: z.string().min(1),
    ownerUserId: DiscordSnowflakeSchema,
    ownerConfirmedAt: IsoTimestampSchema.optional(),
    state: BotCredentialStateSchema,
  })
  .strict();

const GroupAccessPolicySchema = z
  .object({
    requireMention: z.boolean(),
    allowFrom: z.array(DiscordSnowflakeSchema),
  })
  .strict();

const UniqueSnowflakeArraySchema = z
  .array(DiscordSnowflakeSchema)
  .superRefine((values, context) => {
    const seen = new Set<string>();
    for (const [index, value] of values.entries()) {
      if (seen.has(value)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate Discord snowflake: ${value}`,
          path: [index],
        });
      }
      seen.add(value);
    }
  });

const PendingPairingSchema = z
  .object({
    senderId: DiscordSnowflakeSchema,
    dmChannelId: DiscordSnowflakeSchema,
    createdAt: IsoTimestampSchema,
    expiresAt: IsoTimestampSchema,
    replyCount: z.number().int().nonnegative(),
  })
  .strict()
  .refine(
    ({ createdAt, expiresAt }) => Date.parse(expiresAt) > Date.parse(createdAt),
    "Pairing expiry must be after creation",
  );

function guardedRecord<Key extends z.ZodType<string>, Value extends z.ZodType>(
  keySchema: Key,
  valueSchema: Value,
  forbiddenKeys: ReadonlySet<string> = UNSAFE_RECORD_KEYS,
) {
  return z
    .unknown()
    .superRefine((value, context) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return;
      }
      for (const key of Object.keys(value)) {
        if (forbiddenKeys.has(key)) {
          context.addIssue({
            code: "custom",
            message: `Unsafe record key: ${key}`,
            path: [key],
          });
        }
      }
    })
    .pipe(z.record(keySchema, valueSchema));
}

const PROTOTYPE_ASSIGNMENT_KEYS = new Set(["__proto__"]);

export const AccessPolicySchema = z
  .object({
    dmPolicy: z.enum(["pairing", "allowlist", "disabled"]),
    allowFrom: UniqueSnowflakeArraySchema,
    groups: guardedRecord(DiscordSnowflakeSchema, GroupAccessPolicySchema),
    pendingPairings: guardedRecord(PairingCodeSchema, PendingPairingSchema),
    mentionPatterns: z.array(z.string()),
    ackReaction: z.string().min(1),
    replyToMode: z.enum(["off", "first", "all"]),
    textChunkLimit: z.number().int().positive(),
    chunkMode: z.enum(["length", "newline"]),
  })
  .strict();

const WorkspaceProfileObjectSchema = z
  .object({
    name: NameSchema,
    cwd: z.string().min(1),
    permissions: NameSchema.optional(),
    sandbox: z.string().min(1).optional(),
    approvalPolicy: z.string().min(1),
    model: z.string().min(1).optional(),
    serviceTier: z.string().min(1).optional(),
    runtimeWorkspaceRoots: z.array(z.string().min(1)),
    developerInstructions: z.string().optional(),
  })
  .strict();

export const WorkspaceProfileSchema = WorkspaceProfileObjectSchema.strict().refine(
  ({ permissions, sandbox }) => (permissions === undefined) !== (sandbox === undefined),
  "Workspace profile must define exactly one of permissions or sandbox",
);

const PersistedWorkspaceProfileSchema = WorkspaceProfileObjectSchema.refine(
  ({ permissions, sandbox }) => permissions === undefined || sandbox === undefined,
  "Persisted workspace profile cannot define both permissions and sandbox",
).transform(
  (profile): z.infer<typeof WorkspaceProfileSchema> =>
    profile.permissions === undefined && profile.sandbox === undefined
      ? { ...profile, sandbox: "read-only" }
      : profile,
);

export const AgentBindingSchema = z
  .object({
    id: IdentifierSchema,
    name: NameSchema,
    botName: NameSchema,
    threadId: ThreadIdSchema,
    previousThreadIds: z.array(ThreadIdSchema),
    workspace: NameSchema,
    tmuxSession: z
      .string()
      .min(1)
      .regex(/^[A-Za-z0-9_.-]+$/, "Expected a tmux-safe session name"),
    desiredState: DesiredBindingStateSchema,
    observedState: ObservedBindingStateSchema,
    modelId: ModelIdSchema.optional(),
    reasoningEffort: ReasoningEffortSchema.optional(),
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
  })
  .strict();

function addDuplicateIssue(
  context: z.core.$RefinementCtx<unknown>,
  label: string,
  value: string,
  path: PropertyKey[],
): void {
  context.addIssue({
    code: "custom",
    message: `Duplicate ${label}: ${value}`,
    path,
  });
}

function ownValue<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function expectedBotState(observedState: ObservedBindingState): BotCredentialState {
  switch (observedState) {
    case "stopped":
    case "starting":
      return "bound";
    case "running":
    case "stopping":
      return "running";
    case "failed":
      return "failed";
  }
}

export const RegistryDocumentSchema = z
  .object({
    version: z.literal(1),
    bots: guardedRecord(NameSchema, BotCredentialMetadataSchema, PROTOTYPE_ASSIGNMENT_KEYS),
    access: guardedRecord(NameSchema, AccessPolicySchema, PROTOTYPE_ASSIGNMENT_KEYS),
    workspaces: guardedRecord(
      NameSchema,
      PersistedWorkspaceProfileSchema,
      PROTOTYPE_ASSIGNMENT_KEYS,
    ),
    bindings: guardedRecord(IdentifierSchema, AgentBindingSchema),
  })
  .strict()
  .superRefine((document, context) => {
    const applicationIds = new Set<string>();
    const botUserIds = new Set<string>();
    const keychainAccounts = new Set<string>();

    for (const [key, bot] of Object.entries(document.bots)) {
      if (key !== bot.name) {
        context.addIssue({
          code: "custom",
          message: `Bot key ${key} does not match bot name ${bot.name}`,
          path: ["bots", key, "name"],
        });
      }
      if (applicationIds.has(bot.applicationId)) {
        addDuplicateIssue(context, "Discord application ID", bot.applicationId, [
          "bots",
          key,
          "applicationId",
        ]);
      }
      if (botUserIds.has(bot.botUserId)) {
        addDuplicateIssue(context, "Discord bot user ID", bot.botUserId, [
          "bots",
          key,
          "botUserId",
        ]);
      }
      if (keychainAccounts.has(bot.keychainAccount)) {
        addDuplicateIssue(context, "Keychain account", bot.keychainAccount, [
          "bots",
          key,
          "keychainAccount",
        ]);
      }
      applicationIds.add(bot.applicationId);
      botUserIds.add(bot.botUserId);
      keychainAccounts.add(bot.keychainAccount);

      const access = ownValue(document.access, key);
      if (access === undefined) {
        context.addIssue({
          code: "custom",
          message: `Bot ${key} has no access policy`,
          path: ["access", key],
        });
      } else if (!access.allowFrom.includes(bot.ownerUserId)) {
        context.addIssue({
          code: "custom",
          message: `Bot owner ${bot.ownerUserId} is missing from the automatic allowlist`,
          path: ["access", key, "allowFrom"],
        });
      }
    }

    for (const key of Object.keys(document.access)) {
      if (!Object.hasOwn(document.bots, key)) {
        context.addIssue({
          code: "custom",
          message: `Access policy ${key} has no matching bot`,
          path: ["access", key],
        });
      }
    }

    for (const [key, workspace] of Object.entries(document.workspaces)) {
      if (key !== workspace.name) {
        context.addIssue({
          code: "custom",
          message: `Workspace key ${key} does not match workspace name ${workspace.name}`,
          path: ["workspaces", key, "name"],
        });
      }
    }

    const bindingNames = new Set<string>();
    const bindingBotNames = new Set<string>();
    const currentThreadIds = new Set<string>();
    const tmuxSessions = new Set<string>();
    const bindingsByBot = new Map<string, AgentBinding>();

    for (const [key, binding] of Object.entries(document.bindings)) {
      if (key !== binding.id) {
        context.addIssue({
          code: "custom",
          message: `Binding key ${key} does not match binding ID ${binding.id}`,
          path: ["bindings", key, "id"],
        });
      }

      const uniqueValues: ReadonlyArray<readonly [Set<string>, string, string, PropertyKey[]]> = [
        [bindingNames, binding.name, "binding name", ["bindings", key, "name"]],
        [bindingBotNames, binding.botName, "binding bot name", ["bindings", key, "botName"]],
        [
          currentThreadIds,
          binding.threadId,
          "current Codex thread ID",
          ["bindings", key, "threadId"],
        ],
        [tmuxSessions, binding.tmuxSession, "tmux session", ["bindings", key, "tmuxSession"]],
      ];

      for (const [seen, value, label, path] of uniqueValues) {
        if (seen.has(value)) {
          addDuplicateIssue(context, label, value, path);
        }
        seen.add(value);
      }

      if (!Object.hasOwn(document.bots, binding.botName)) {
        context.addIssue({
          code: "custom",
          message: `Binding references missing bot ${binding.botName}`,
          path: ["bindings", key, "botName"],
        });
      }
      if (!Object.hasOwn(document.workspaces, binding.workspace)) {
        context.addIssue({
          code: "custom",
          message: `Binding references missing workspace ${binding.workspace}`,
          path: ["bindings", key, "workspace"],
        });
      }
      bindingsByBot.set(binding.botName, binding);
    }

    for (const [key, bot] of Object.entries(document.bots)) {
      const binding = bindingsByBot.get(key);
      if (binding === undefined) {
        if (bot.state !== "registering" && bot.state !== "registered" && bot.state !== "deleting") {
          context.addIssue({
            code: "custom",
            message: `Unbound bot ${key} cannot be in state ${bot.state}`,
            path: ["bots", key, "state"],
          });
        }
        continue;
      }

      const expected = expectedBotState(binding.observedState);
      if (bot.state !== expected) {
        context.addIssue({
          code: "custom",
          message: `Bot ${key} must be ${expected} while binding is ${binding.observedState}`,
          path: ["bots", key, "state"],
        });
      }
    }
  });

export type BotCredentialState = z.infer<typeof BotCredentialStateSchema>;
export type DesiredBindingState = z.infer<typeof DesiredBindingStateSchema>;
export type ObservedBindingState = z.infer<typeof ObservedBindingStateSchema>;
export type BotCredentialMetadata = z.infer<typeof BotCredentialMetadataSchema>;
export type AccessPolicy = z.infer<typeof AccessPolicySchema>;
export type WorkspaceProfile = z.infer<typeof WorkspaceProfileSchema>;
export type AgentModelSettings = z.infer<typeof AgentModelSettingsSchema>;
export type AgentBinding = z.infer<typeof AgentBindingSchema>;
export type RegistryDocument = z.infer<typeof RegistryDocumentSchema>;
