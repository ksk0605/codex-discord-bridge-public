import { z } from "zod";

export const RequestIdSchema = z.union([z.string(), z.number().int().safe()]);
export type RequestId = z.infer<typeof RequestIdSchema>;

export const ProtocolErrorSchema = z
  .object({
    code: z.number().int(),
    message: z.string(),
    data: z.unknown().optional(),
  })
  .passthrough();
export type ProtocolError = z.infer<typeof ProtocolErrorSchema>;

export interface SuccessResponse<Result> {
  id: RequestId;
  result: Result;
}

export interface ErrorResponse {
  id: RequestId;
  error: ProtocolError;
}

export const SuccessResponseEnvelopeSchema = z
  .object({ id: RequestIdSchema, result: z.unknown() })
  .passthrough()
  .superRefine((value, context) => {
    if (Object.hasOwn(value, "error")) {
      context.addIssue({ code: "custom", message: "Success response cannot contain error" });
    }
  });
export const ErrorResponseEnvelopeSchema = z
  .object({ id: RequestIdSchema, error: ProtocolErrorSchema })
  .passthrough()
  .superRefine((value, context) => {
    if (Object.hasOwn(value, "result")) {
      context.addIssue({ code: "custom", message: "Error response cannot contain result" });
    }
  });

const ClientInfoSchema = z
  .object({
    name: z.string(),
    title: z.string().nullable().optional(),
    version: z.string(),
  })
  .passthrough();

export const InitializeParamsSchema = z
  .object({
    clientInfo: ClientInfoSchema,
    capabilities: z
      .object({
        experimentalApi: z.boolean(),
        requestAttestation: z.boolean(),
      })
      .passthrough(),
  })
  .passthrough();

export const InitializeResponseSchema = z
  .object({
    codexHome: z.string(),
    platformFamily: z.string(),
    platformOs: z.string(),
    userAgent: z.string(),
  })
  .passthrough();

const ApprovalPolicySchema = z.union([
  z.enum(["untrusted", "on-request", "never"]),
  z
    .object({
      granular: z
        .object({
          mcp_elicitations: z.boolean(),
          request_permissions: z.boolean().optional(),
          rules: z.boolean(),
          sandbox_approval: z.boolean(),
          skill_approval: z.boolean().optional(),
        })
        .strict(),
    })
    .strict(),
]);
const SandboxModeSchema = z.enum(["read-only", "workspace-write", "danger-full-access"]);
const DynamicFunctionToolSchema = z
  .object({
    type: z.literal("function"),
    name: z.string(),
    description: z.string(),
    inputSchema: z.unknown(),
    deferLoading: z.boolean().optional(),
  })
  .passthrough()
  .superRefine((value, context) => {
    if (!Object.hasOwn(value, "inputSchema")) {
      context.addIssue({ code: "custom", message: "Dynamic function tool requires inputSchema" });
    }
  });
const DynamicToolSpecSchema = z.discriminatedUnion("type", [
  DynamicFunctionToolSchema,
  z
    .object({
      type: z.literal("namespace"),
      name: z.string(),
      description: z.string(),
      tools: z.array(DynamicFunctionToolSchema),
    })
    .passthrough(),
]);
export const ThreadSourceKindSchema = z.enum([
  "cli",
  "vscode",
  "exec",
  "appServer",
  "subAgent",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "subAgentOther",
  "unknown",
]);
export type ThreadSourceKind = z.infer<typeof ThreadSourceKindSchema>;

const ThreadConfigurationSchema = {
  cwd: z.string().nullable().optional(),
  approvalPolicy: ApprovalPolicySchema.nullable().optional(),
  sandbox: SandboxModeSchema.nullable().optional(),
  permissions: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  serviceTier: z.string().nullable().optional(),
  runtimeWorkspaceRoots: z.array(z.string()).nullable().optional(),
  developerInstructions: z.string().nullable().optional(),
} as const;

export const ThreadSchema = z
  .object({
    id: z.string(),
    preview: z.string().optional(),
    cwd: z.string().optional(),
    name: z.string().nullable().optional(),
    createdAt: z.number().int().optional(),
    updatedAt: z.number().int().optional(),
    turns: z.array(z.unknown()).optional(),
  })
  .passthrough();
export type Thread = z.infer<typeof ThreadSchema>;

export const TurnStatusSchema = z.enum(["completed", "interrupted", "failed", "inProgress"]);
export const TurnSchema = z
  .object({
    id: z.string(),
    items: z.array(z.unknown()),
    status: TurnStatusSchema,
    error: z.unknown().nullable().optional(),
  })
  .passthrough();
export type Turn = z.infer<typeof TurnSchema>;

export const ThreadStartParamsSchema = z
  .object({
    ...ThreadConfigurationSchema,
    dynamicTools: z.array(DynamicToolSpecSchema).nullable().optional(),
    ephemeral: z.boolean().nullable().optional(),
  })
  .passthrough();
export const ThreadResumeParamsSchema = z
  .object({ threadId: z.string(), ...ThreadConfigurationSchema })
  .passthrough();
export const ThreadListParamsSchema = z
  .object({
    cursor: z.string().nullable().optional(),
    limit: z.number().int().nonnegative().max(4_294_967_295).nullable().optional(),
    sourceKinds: z.array(ThreadSourceKindSchema).nullable().optional(),
  })
  .passthrough();
export const ThreadReadParamsSchema = z
  .object({ threadId: z.string(), includeTurns: z.boolean().optional() })
  .passthrough();
export const ThreadInjectItemsParamsSchema = z
  .object({ threadId: z.string(), items: z.array(z.unknown()).min(1) })
  .passthrough();
export const ThreadResponseSchema = z.object({ thread: ThreadSchema }).passthrough();
export const ThreadInjectItemsResponseSchema = z.object({}).passthrough();
export const ThreadListResponseSchema = z
  .object({ data: z.array(ThreadSchema), nextCursor: z.string().nullable().optional() })
  .passthrough()
  .transform((value) => ({ ...value, nextCursor: value.nextCursor ?? null }));

export const ModelListParamsSchema = z
  .object({
    cursor: z.string().nullable().optional(),
    limit: z.number().int().nonnegative().max(4_294_967_295).nullable().optional(),
    includeHidden: z.boolean().nullable().optional(),
  })
  .passthrough();
const ReasoningEffortOptionSchema = z
  .object({
    reasoningEffort: z.string().min(1),
    description: z.string(),
  })
  .passthrough();
export const ModelSchema = z
  .object({
    id: z.string(),
    model: z.string(),
    displayName: z.string(),
    description: z.string(),
    hidden: z.boolean(),
    isDefault: z.boolean(),
    defaultReasoningEffort: z.string().min(1),
    supportedReasoningEfforts: z.array(ReasoningEffortOptionSchema),
  })
  .passthrough();
export const ModelListResponseSchema = z
  .object({
    data: z.array(ModelSchema),
    nextCursor: z.string().nullable().optional(),
  })
  .passthrough()
  .transform((value) => ({ ...value, nextCursor: value.nextCursor ?? null }));

export const UserInputSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("text"),
      text: z.string(),
      text_elements: z
        .array(
          z
            .object({
              byteRange: z
                .object({
                  start: z.number().int().nonnegative(),
                  end: z.number().int().nonnegative(),
                })
                .passthrough(),
              placeholder: z.string().nullable().optional(),
            })
            .passthrough(),
        )
        .optional(),
    })
    .passthrough(),
  z.object({ type: z.literal("image"), url: z.string() }).passthrough(),
  z.object({ type: z.literal("localImage"), path: z.string() }).passthrough(),
  z.object({ type: z.literal("audio"), url: z.string() }).passthrough(),
  z.object({ type: z.literal("localAudio"), path: z.string() }).passthrough(),
  z.object({ type: z.literal("skill"), name: z.string(), path: z.string() }).passthrough(),
  z.object({ type: z.literal("mention"), name: z.string(), path: z.string() }).passthrough(),
]);
export type UserInput = z.infer<typeof UserInputSchema>;

export const TurnStartParamsSchema = z
  .object({
    threadId: z.string(),
    input: z.array(UserInputSchema),
    model: z.string().nullable().optional(),
    effort: z.string().nullable().optional(),
    clientUserMessageId: z.string().nullable().optional(),
    responsesapiClientMetadata: z.record(z.string(), z.string()).nullable().optional(),
  })
  .passthrough();
export const TurnStartResponseSchema = z.object({ turn: TurnSchema }).passthrough();
export const TurnInterruptParamsSchema = z
  .object({ threadId: z.string(), turnId: z.string() })
  .passthrough();
export const TurnInterruptResponseSchema = z.object({}).passthrough();

export const clientRequestSchemas = {
  initialize: { params: InitializeParamsSchema, result: InitializeResponseSchema },
  "thread/start": { params: ThreadStartParamsSchema, result: ThreadResponseSchema },
  "thread/resume": { params: ThreadResumeParamsSchema, result: ThreadResponseSchema },
  "thread/list": { params: ThreadListParamsSchema, result: ThreadListResponseSchema },
  "model/list": { params: ModelListParamsSchema, result: ModelListResponseSchema },
  "thread/read": { params: ThreadReadParamsSchema, result: ThreadResponseSchema },
  "thread/inject_items": {
    params: ThreadInjectItemsParamsSchema,
    result: ThreadInjectItemsResponseSchema,
  },
  "turn/start": { params: TurnStartParamsSchema, result: TurnStartResponseSchema },
  "turn/interrupt": { params: TurnInterruptParamsSchema, result: TurnInterruptResponseSchema },
} as const;

export type ClientRequestMethod = keyof typeof clientRequestSchemas;
export type ClientRequestParams<Method extends ClientRequestMethod> = z.input<
  (typeof clientRequestSchemas)[Method]["params"]
>;
export type ClientRequestResult<Method extends ClientRequestMethod> = z.output<
  (typeof clientRequestSchemas)[Method]["result"]
>;

export const clientNotificationSchemas = {
  initialized: z.undefined(),
} as const;
export type ClientNotificationMethod = keyof typeof clientNotificationSchemas;
export type ClientNotificationParams<Method extends ClientNotificationMethod> = z.input<
  (typeof clientNotificationSchemas)[Method]
>;

const ProtocolIdentifierSchema = z.string().min(1).max(512);
const ProtocolShortTextSchema = z.string().max(65_536);
const ProtocolPathSchema = z.string().max(8_192);
const ProtocolLargeTextSchema = z.string().max(2 * 1024 * 1024);
const ProgressStatusSchema = z.enum(["inProgress", "completed", "failed"]);
const CompletionStatusSchema = z.enum(["inProgress", "completed", "failed", "declined"]);

export type AgentMessagePhase = "commentary" | "final_answer";

export function knownAgentMessagePhase(item: unknown): AgentMessagePhase | undefined {
  if (typeof item !== "object" || item === null || !Object.hasOwn(item, "phase")) {
    return undefined;
  }
  const phase = (item as { phase?: unknown }).phase;
  return phase === "commentary" || phase === "final_answer" ? phase : undefined;
}

interface ThreadItem {
  id: string;
  type: string;
  [key: string]: unknown;
}

const ThreadItemBaseSchema = z
  .object({ id: ProtocolIdentifierSchema, type: ProtocolIdentifierSchema })
  .passthrough();
const AgentMessageItemSchema = z
  .object({
    id: ProtocolIdentifierSchema,
    phase: z.unknown().optional(),
    text: ProtocolLargeTextSchema,
    type: z.literal("agentMessage"),
  })
  .passthrough();
const CommandExecutionItemSchema = z
  .object({
    command: ProtocolShortTextSchema,
    cwd: ProtocolPathSchema,
    id: ProtocolIdentifierSchema,
    status: CompletionStatusSchema,
    type: z.literal("commandExecution"),
  })
  .passthrough();
const FileChangeItemSchema = z
  .object({
    changes: z
      .array(
        z
          .object({
            diff: ProtocolLargeTextSchema.optional(),
            kind: z.object({ type: z.enum(["add", "delete", "update"]) }).passthrough(),
            path: ProtocolPathSchema,
          })
          .passthrough(),
      )
      .max(4_096),
    id: ProtocolIdentifierSchema,
    status: CompletionStatusSchema,
    type: z.literal("fileChange"),
  })
  .passthrough();
const McpToolCallItemSchema = z
  .object({
    id: ProtocolIdentifierSchema,
    server: ProtocolShortTextSchema,
    status: ProgressStatusSchema,
    tool: ProtocolShortTextSchema,
    type: z.literal("mcpToolCall"),
  })
  .passthrough();
const DynamicToolCallItemSchema = z
  .object({
    id: ProtocolIdentifierSchema,
    namespace: ProtocolShortTextSchema.nullable().optional(),
    status: ProgressStatusSchema,
    tool: ProtocolShortTextSchema,
    type: z.literal("dynamicToolCall"),
  })
  .passthrough();
const CollabAgentToolCallItemSchema = z
  .object({
    id: ProtocolIdentifierSchema,
    status: ProgressStatusSchema,
    tool: z.enum(["spawnAgent", "sendInput", "resumeAgent", "wait", "closeAgent"]),
    type: z.literal("collabAgentToolCall"),
  })
  .passthrough();
const SubAgentActivityItemSchema = z
  .object({
    agentPath: ProtocolPathSchema,
    agentThreadId: ProtocolIdentifierSchema,
    id: ProtocolIdentifierSchema,
    kind: z.enum(["started", "interacted", "interrupted"]),
    type: z.literal("subAgentActivity"),
  })
  .passthrough();
const WebSearchItemSchema = z
  .object({
    id: ProtocolIdentifierSchema,
    query: ProtocolShortTextSchema,
    type: z.literal("webSearch"),
  })
  .passthrough();

const consumedThreadItemSchemas = {
  agentMessage: AgentMessageItemSchema,
  commandExecution: CommandExecutionItemSchema,
  fileChange: FileChangeItemSchema,
  mcpToolCall: McpToolCallItemSchema,
  dynamicToolCall: DynamicToolCallItemSchema,
  collabAgentToolCall: CollabAgentToolCallItemSchema,
  subAgentActivity: SubAgentActivityItemSchema,
  webSearch: WebSearchItemSchema,
} as const;

const ThreadItemSchema = z.unknown().transform((value, context): ThreadItem => {
  const base = ThreadItemBaseSchema.safeParse(value);
  if (!base.success) {
    context.addIssue({ code: "custom", message: "Invalid thread item identity." });
    return z.NEVER;
  }
  const type = base.data.type as keyof typeof consumedThreadItemSchemas;
  const consumedSchema = consumedThreadItemSchemas[type];
  if (consumedSchema === undefined) {
    return base.data as ThreadItem;
  }
  const consumed = consumedSchema.safeParse(value);
  if (!consumed.success) {
    context.addIssue({ code: "custom", message: `Invalid ${type} thread item.` });
    return z.NEVER;
  }
  return consumed.data as ThreadItem;
});

const TurnNotificationSchema = z
  .object({ threadId: ProtocolIdentifierSchema, turn: TurnSchema })
  .passthrough();
const ItemStartedNotificationSchema = z
  .object({
    item: ThreadItemSchema,
    startedAtMs: z.number().int(),
    threadId: ProtocolIdentifierSchema,
    turnId: ProtocolIdentifierSchema,
  })
  .passthrough();
const ItemCompletedNotificationSchema = z
  .object({
    completedAtMs: z.number().int(),
    item: ThreadItemSchema,
    threadId: ProtocolIdentifierSchema,
    turnId: ProtocolIdentifierSchema,
  })
  .passthrough();
const AgentMessageDeltaNotificationSchema = z
  .object({
    delta: ProtocolShortTextSchema,
    itemId: ProtocolIdentifierSchema,
    threadId: ProtocolIdentifierSchema,
    turnId: ProtocolIdentifierSchema,
  })
  .passthrough();
const ErrorNotificationSchema = z
  .object({
    error: z.object({ message: ProtocolShortTextSchema }).passthrough(),
    threadId: ProtocolIdentifierSchema,
    turnId: ProtocolIdentifierSchema,
    willRetry: z.boolean(),
  })
  .passthrough();
const TurnPlanStepStatusSchema = z.enum(["pending", "inProgress", "completed"]);
const TurnPlanUpdatedNotificationSchema = z
  .object({
    explanation: ProtocolShortTextSchema.nullable().optional(),
    plan: z
      .array(
        z
          .object({
            status: TurnPlanStepStatusSchema,
            step: ProtocolShortTextSchema,
          })
          .passthrough(),
      )
      .max(128),
    threadId: ProtocolIdentifierSchema,
    turnId: ProtocolIdentifierSchema,
  })
  .passthrough();
const TurnDiffUpdatedNotificationSchema = z
  .object({
    diff: ProtocolLargeTextSchema,
    threadId: ProtocolIdentifierSchema,
    turnId: ProtocolIdentifierSchema,
  })
  .passthrough();
const ReasoningSummaryTextDeltaNotificationSchema = z
  .object({
    delta: ProtocolShortTextSchema,
    itemId: ProtocolIdentifierSchema,
    summaryIndex: z.number().int().nonnegative().max(1_000_000),
    threadId: ProtocolIdentifierSchema,
    turnId: ProtocolIdentifierSchema,
  })
  .passthrough();
const ReasoningSummaryPartAddedNotificationSchema = z
  .object({
    itemId: ProtocolIdentifierSchema,
    summaryIndex: z.number().int().nonnegative().max(1_000_000),
    threadId: ProtocolIdentifierSchema,
    turnId: ProtocolIdentifierSchema,
  })
  .passthrough();
const CommandExecutionOutputDeltaNotificationSchema = z
  .object({
    delta: ProtocolShortTextSchema,
    itemId: ProtocolIdentifierSchema,
    threadId: ProtocolIdentifierSchema,
    turnId: ProtocolIdentifierSchema,
  })
  .passthrough();
const WarningNotificationSchema = z
  .object({
    message: ProtocolShortTextSchema,
    threadId: ProtocolIdentifierSchema.nullable().optional(),
  })
  .passthrough();

export const serverNotificationSchemas = {
  "turn/started": TurnNotificationSchema,
  "turn/completed": TurnNotificationSchema,
  "item/started": ItemStartedNotificationSchema,
  "item/completed": ItemCompletedNotificationSchema,
  "item/agentMessage/delta": AgentMessageDeltaNotificationSchema,
  "turn/plan/updated": TurnPlanUpdatedNotificationSchema,
  "turn/diff/updated": TurnDiffUpdatedNotificationSchema,
  "item/reasoning/summaryTextDelta": ReasoningSummaryTextDeltaNotificationSchema,
  "item/reasoning/summaryPartAdded": ReasoningSummaryPartAddedNotificationSchema,
  "item/commandExecution/outputDelta": CommandExecutionOutputDeltaNotificationSchema,
  warning: WarningNotificationSchema,
  error: ErrorNotificationSchema,
} as const;
export type ServerNotificationMethod = keyof typeof serverNotificationSchemas;
export type ServerNotificationParams<Method extends ServerNotificationMethod> = z.output<
  (typeof serverNotificationSchemas)[Method]
>;

export const CurrentApprovalDecisionSchema = z.enum([
  "accept",
  "acceptForSession",
  "decline",
  "cancel",
]);
export type CurrentApprovalDecision = z.infer<typeof CurrentApprovalDecisionSchema>;
export const CurrentApprovalResultSchema = z
  .object({ decision: CurrentApprovalDecisionSchema })
  .strict();

const DeniedDecisionSchema = z
  .object({ denied: z.object({ rejection: z.string() }).strict() })
  .strict();
export const LegacyApprovalDecisionSchema = z.union([
  z.enum(["approved", "approved_for_session", "abort"]),
  DeniedDecisionSchema,
]);
export type LegacyApprovalDecision = z.infer<typeof LegacyApprovalDecisionSchema>;
export const LegacyApprovalResultSchema = z
  .object({ decision: LegacyApprovalDecisionSchema })
  .strict();

export const FileSystemSpecialPathSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("root") }).strict(),
  z.object({ kind: z.literal("minimal") }).strict(),
  z
    .object({ kind: z.literal("project_roots"), subpath: z.string().nullable().optional() })
    .strict(),
  z.object({ kind: z.literal("tmpdir") }).strict(),
  z.object({ kind: z.literal("slash_tmp") }).strict(),
  z
    .object({
      kind: z.literal("unknown"),
      path: z.string(),
      subpath: z.string().nullable().optional(),
    })
    .strict(),
]);
export const FileSystemPathSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("path"), path: z.string() }).strict(),
  z.object({ type: z.literal("glob_pattern"), pattern: z.string() }).strict(),
  z.object({ type: z.literal("special"), value: FileSystemSpecialPathSchema }).strict(),
]);
export const FileSystemEntrySchema = z
  .object({ access: z.enum(["read", "write", "deny"]), path: FileSystemPathSchema })
  .strict();
export const FileSystemPermissionsSchema = z
  .object({
    entries: z.array(FileSystemEntrySchema).nullable().optional(),
    globScanMaxDepth: z.number().int().positive().nullable().optional(),
    read: z.array(z.string()).nullable().optional(),
    write: z.array(z.string()).nullable().optional(),
  })
  .strict();
export const NetworkPermissionsSchema = z
  .object({ enabled: z.boolean().nullable().optional() })
  .strict();
export const PermissionProfileSchema = z
  .object({
    fileSystem: FileSystemPermissionsSchema.nullable().optional(),
    network: NetworkPermissionsSchema.nullable().optional(),
  })
  .strict();
export type PermissionProfile = z.infer<typeof PermissionProfileSchema>;

export function isRepresentablePermissionProfile(profile: PermissionProfile): boolean {
  const profileKeys = new Set(["fileSystem", "network"]);
  if (Object.keys(profile).some((key) => !profileKeys.has(key))) {
    return false;
  }
  if (profile.network !== undefined && profile.network !== null) {
    if (Object.keys(profile.network).some((key) => key !== "enabled")) {
      return false;
    }
  }
  if (profile.fileSystem !== undefined && profile.fileSystem !== null) {
    const fileSystemKeys = new Set(["entries", "globScanMaxDepth", "read", "write"]);
    if (Object.keys(profile.fileSystem).some((key) => !fileSystemKeys.has(key))) {
      return false;
    }
    if (
      profile.fileSystem.entries?.some((entry) =>
        Object.keys(entry).some((key) => key !== "access" && key !== "path"),
      ) === true
    ) {
      return false;
    }
  }
  return true;
}

const CurrentApprovalParamsBase = {
  itemId: z.string(),
  startedAtMs: z.number().int(),
  threadId: z.string(),
  turnId: z.string(),
} as const;
export const NetworkApprovalProtocolSchema = z.enum(["http", "https", "socks5Tcp", "socks5Udp"]);
export const NetworkApprovalContextSchema = z
  .object({ host: z.string(), protocol: NetworkApprovalProtocolSchema })
  .strict();
export const AdditionalPermissionProfileSchema = z
  .object({
    fileSystem: FileSystemPermissionsSchema.nullable().optional(),
    network: NetworkPermissionsSchema.nullable().optional(),
  })
  .strict();
export const CommandActionSchema = z.discriminatedUnion("type", [
  z
    .object({
      command: z.string(),
      name: z.string(),
      path: z.string(),
      type: z.literal("read"),
    })
    .strict(),
  z
    .object({
      command: z.string(),
      path: z.string().nullable().optional(),
      type: z.literal("listFiles"),
    })
    .strict(),
  z
    .object({
      command: z.string(),
      path: z.string().nullable().optional(),
      query: z.string().nullable().optional(),
      type: z.literal("search"),
    })
    .strict(),
  z.object({ command: z.string(), type: z.literal("unknown") }).strict(),
]);
export const NetworkPolicyAmendmentSchema = z
  .object({ action: z.enum(["allow", "deny"]), host: z.string() })
  .strict();
const ExecpolicyAmendmentDecisionSchema = z
  .object({
    acceptWithExecpolicyAmendment: z.object({ execpolicy_amendment: z.array(z.string()) }).strict(),
  })
  .strict();
const NetworkPolicyAmendmentDecisionSchema = z
  .object({
    applyNetworkPolicyAmendment: z
      .object({ network_policy_amendment: NetworkPolicyAmendmentSchema })
      .strict(),
  })
  .strict();
export const CommandExecutionApprovalDecisionSchema = z.union([
  CurrentApprovalDecisionSchema,
  ExecpolicyAmendmentDecisionSchema,
  NetworkPolicyAmendmentDecisionSchema,
]);

export const CommandApprovalParamsSchema = z
  .object({
    ...CurrentApprovalParamsBase,
    additionalPermissions: AdditionalPermissionProfileSchema.nullable().optional(),
    approvalId: z.string().nullable().optional(),
    availableDecisions: z.array(CommandExecutionApprovalDecisionSchema).nullable().optional(),
    command: z.string().nullable().optional(),
    commandActions: z.array(CommandActionSchema).nullable().optional(),
    cwd: z.string().nullable().optional(),
    environmentId: z.string().nullable().optional(),
    networkApprovalContext: NetworkApprovalContextSchema.nullable().optional(),
    proposedExecpolicyAmendment: z.array(z.string()).nullable().optional(),
    proposedNetworkPolicyAmendments: z.array(NetworkPolicyAmendmentSchema).nullable().optional(),
    reason: z.string().nullable().optional(),
  })
  .strict();
export type CommandApprovalParams = z.output<typeof CommandApprovalParamsSchema>;
export const FileChangeApprovalParamsSchema = z
  .object({
    ...CurrentApprovalParamsBase,
    grantRoot: z.string().nullable().optional(),
    reason: z.string().nullable().optional(),
  })
  .strict();
export const PermissionApprovalParamsSchema = z
  .object({
    ...CurrentApprovalParamsBase,
    cwd: z.string(),
    environmentId: z.string().nullable().optional(),
    permissions: PermissionProfileSchema,
    reason: z.string().nullable().optional(),
  })
  .strict();
export const PermissionGrantScopeSchema = z.enum(["turn", "session"]);
export type PermissionGrantScope = z.infer<typeof PermissionGrantScopeSchema>;
export const PermissionApprovalResultSchema = z
  .object({
    permissions: PermissionProfileSchema,
    scope: PermissionGrantScopeSchema.optional(),
    strictAutoReview: z.boolean().nullable().optional(),
  })
  .strict()
  .refine(
    ({ permissions }) => isRepresentablePermissionProfile(permissions),
    "Permission grant contains an unrepresentable profile",
  );

export const DynamicToolCallParamsSchema = z
  .object({
    arguments: z.unknown(),
    callId: z.string(),
    namespace: z.string().nullable().optional(),
    threadId: z.string(),
    tool: z.string(),
    turnId: z.string(),
  })
  .passthrough();
export const DynamicToolContentItemSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("inputText"), text: z.string() }).strict(),
  z.object({ type: z.literal("inputImage"), imageUrl: z.string() }).strict(),
  z.object({ type: z.literal("inputAudio"), audioUrl: z.string() }).strict(),
]);
export type DynamicToolContentItem = z.infer<typeof DynamicToolContentItemSchema>;
export const DynamicToolResultSchema = z
  .object({
    contentItems: z.array(DynamicToolContentItemSchema),
    success: z.boolean(),
  })
  .strict();

export const ParsedCommandSchema = z.discriminatedUnion("type", [
  z
    .object({ cmd: z.string(), name: z.string(), path: z.string(), type: z.literal("read") })
    .strict(),
  z
    .object({
      cmd: z.string(),
      path: z.string().nullable().optional(),
      type: z.literal("list_files"),
    })
    .strict(),
  z
    .object({
      cmd: z.string(),
      path: z.string().nullable().optional(),
      query: z.string().nullable().optional(),
      type: z.literal("search"),
    })
    .strict(),
  z.object({ cmd: z.string(), type: z.literal("unknown") }).strict(),
]);
export type ParsedCommand = z.infer<typeof ParsedCommandSchema>;

export const ExecCommandApprovalParamsSchema = z
  .object({
    approvalId: z.string().nullable().optional(),
    callId: z.string(),
    command: z.array(z.string()),
    conversationId: z.string(),
    cwd: z.string(),
    parsedCmd: z.array(ParsedCommandSchema),
    reason: z.string().nullable().optional(),
  })
  .strict();

export const FileChangeSchema = z.discriminatedUnion("type", [
  z.object({ content: z.string(), type: z.literal("add") }).strict(),
  z.object({ content: z.string(), type: z.literal("delete") }).strict(),
  z
    .object({
      move_path: z.string().nullable().optional(),
      type: z.literal("update"),
      unified_diff: z.string(),
    })
    .strict(),
]);
export type FileChange = z.infer<typeof FileChangeSchema>;
const SafeFileChangePathSchema = z
  .string()
  .refine(
    (path) => !["__proto__", "constructor", "prototype"].includes(path),
    "Unsafe file change path",
  );
export const FileChangesSchema = z
  .unknown()
  .superRefine((value, context) => {
    if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      Object.keys(value).some((key) => ["__proto__", "constructor", "prototype"].includes(key))
    ) {
      context.addIssue({ code: "custom", message: "Unsafe file change path" });
    }
  })
  .pipe(z.record(SafeFileChangePathSchema, FileChangeSchema));
export const ApplyPatchApprovalParamsSchema = z
  .object({
    callId: z.string(),
    conversationId: z.string(),
    fileChanges: FileChangesSchema,
    grantRoot: z.string().nullable().optional(),
    reason: z.string().nullable().optional(),
  })
  .strict();

export const serverRequestSchemas = {
  "item/commandExecution/requestApproval": {
    params: CommandApprovalParamsSchema,
    result: CurrentApprovalResultSchema,
  },
  "item/fileChange/requestApproval": {
    params: FileChangeApprovalParamsSchema,
    result: CurrentApprovalResultSchema,
  },
  "item/permissions/requestApproval": {
    params: PermissionApprovalParamsSchema,
    result: PermissionApprovalResultSchema,
  },
  "item/tool/call": {
    params: DynamicToolCallParamsSchema,
    result: DynamicToolResultSchema,
  },
  execCommandApproval: {
    params: ExecCommandApprovalParamsSchema,
    result: LegacyApprovalResultSchema,
  },
  applyPatchApproval: {
    params: ApplyPatchApprovalParamsSchema,
    result: LegacyApprovalResultSchema,
  },
} as const;
export type ServerRequestMethod = keyof typeof serverRequestSchemas;
export type ServerRequestParams<Method extends ServerRequestMethod> = z.output<
  (typeof serverRequestSchemas)[Method]["params"]
>;
export type ServerRequestResult<Method extends ServerRequestMethod> = z.input<
  (typeof serverRequestSchemas)[Method]["result"]
>;
export type ApprovalRequestMethod = Exclude<ServerRequestMethod, "item/tool/call">;
export type NonApprovalServerRequestMethod = Extract<ServerRequestMethod, "item/tool/call">;
export const MvpApprovalActionSchema = z.enum(["accept", "decline"]);
export type MvpApprovalAction = z.infer<typeof MvpApprovalActionSchema>;

export function currentApprovalResponse(
  id: RequestId,
  decision: CurrentApprovalDecision,
): SuccessResponse<{ decision: CurrentApprovalDecision }> {
  return { id, result: { decision } };
}

export function commandApprovalResponse(
  id: RequestId,
  request: CommandApprovalParams,
  action: MvpApprovalAction,
): SuccessResponse<{ decision: CurrentApprovalDecision }> {
  if (action === "decline") return currentApprovalResponse(id, "decline");
  const parsedRequest = CommandApprovalParamsSchema.safeParse(request);
  if (!parsedRequest.success) {
    return currentApprovalResponse(id, "decline");
  }
  const safeRequest = parsedRequest.data;
  const isAllowed =
    safeRequest.availableDecisions?.some((available) => available === "accept") === true;
  const hasUnrepresentablePrivileges =
    safeRequest.additionalPermissions != null ||
    safeRequest.networkApprovalContext != null ||
    safeRequest.proposedExecpolicyAmendment != null ||
    safeRequest.proposedNetworkPolicyAmendments != null;
  return currentApprovalResponse(
    id,
    isAllowed && !hasUnrepresentablePrivileges ? "accept" : "decline",
  );
}

export function approvalResponseForRequest<Method extends ApprovalRequestMethod>(
  id: RequestId,
  method: Method,
  request: ServerRequestParams<Method>,
  proposedAction: unknown,
): SuccessResponse<unknown> | ErrorResponse {
  const action = MvpApprovalActionSchema.safeParse(proposedAction);
  const accepts = action.success && action.data === "accept";
  switch (method) {
    case "item/commandExecution/requestApproval":
      return commandApprovalResponse(
        id,
        request as ServerRequestParams<"item/commandExecution/requestApproval">,
        accepts ? "accept" : "decline",
      );
    case "item/fileChange/requestApproval": {
      const file = request as ServerRequestParams<"item/fileChange/requestApproval">;
      return currentApprovalResponse(id, accepts && file.grantRoot == null ? "accept" : "decline");
    }
    case "item/permissions/requestApproval": {
      const permission = request as ServerRequestParams<"item/permissions/requestApproval">;
      return accepts
        ? permissionGrantResponse(id, permission.permissions)
        : permissionDeclinedResponse(id);
    }
    case "execCommandApproval":
      return accepts ? legacyApprovalResponse(id, "approved") : legacyDeniedResponse(id);
    case "applyPatchApproval": {
      const patch = request as ServerRequestParams<"applyPatchApproval">;
      return accepts && patch.grantRoot == null
        ? legacyApprovalResponse(id, "approved")
        : legacyDeniedResponse(id);
    }
  }
}

export function legacyApprovalResponse(
  id: RequestId,
  decision: Extract<LegacyApprovalDecision, string>,
): SuccessResponse<{ decision: LegacyApprovalDecision }> {
  return { id, result: { decision } };
}

export function legacyDeniedResponse(
  id: RequestId,
  rejection = "Denied in Discord",
): SuccessResponse<{ decision: LegacyApprovalDecision }> {
  return { id, result: { decision: { denied: { rejection } } } };
}

export function permissionGrantResponse(
  id: RequestId,
  permissions: PermissionProfile,
): SuccessResponse<z.output<typeof PermissionApprovalResultSchema>> | ErrorResponse {
  const result = PermissionApprovalResultSchema.safeParse({ permissions, scope: "turn" });
  return result.success ? { id, result: result.data } : permissionDeclinedResponse(id);
}

export function permissionDeclinedResponse(id: RequestId): ErrorResponse {
  return { id, error: { code: -32_000, message: "Permission request declined" } };
}

export function dynamicToolResponse(
  id: RequestId,
  success: boolean,
  contentItems: DynamicToolContentItem[],
): SuccessResponse<z.input<typeof DynamicToolResultSchema>> {
  return { id, result: { success, contentItems } };
}

export function methodNotSupportedResponse(id: RequestId): ErrorResponse {
  return { id, error: { code: -32_601, message: "Method not supported" } };
}

export function requestFailedResponse(id: RequestId): ErrorResponse {
  return { id, error: { code: -32_603, message: "Request failed" } };
}
