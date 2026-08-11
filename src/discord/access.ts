import { z } from "zod";
import {
  type AccessPolicy,
  AccessPolicySchema,
  type BotCredentialMetadata,
  BotCredentialMetadataSchema,
  DiscordSnowflakeSchema,
  PairingCodeSchema,
} from "../domain/schemas.js";

export const PAIRING_TTL_MS = 60 * 60 * 1_000;
export const DEFAULT_MAX_PENDING_PAIRINGS = 32;
const MAX_PENDING_PAIRINGS = 1_000;
const MAX_MESSAGE_CODE_UNITS = 200_000;

const DiscordAccessEventSchema = z
  .object({
    kind: z.enum(["message", "command", "approval"]),
    location: z.enum(["dm", "guild", "thread"]),
    senderId: DiscordSnowflakeSchema,
    channelId: DiscordSnowflakeSchema,
    guildId: DiscordSnowflakeSchema.optional(),
    parentChannelId: DiscordSnowflakeSchema.optional(),
    content: z.string().max(MAX_MESSAGE_CODE_UNITS),
    mentionsBot: z.boolean(),
    senderIsBot: z.boolean().optional(),
    senderIsSystem: z.boolean().optional(),
  })
  .strict()
  .superRefine((event, context) => {
    if (event.location === "thread" && event.parentChannelId === undefined) {
      context.addIssue({
        code: "custom",
        message: "A Discord thread event requires a parent channel ID.",
        path: ["parentChannelId"],
      });
    }
    if (event.location !== "dm" && event.guildId === undefined) {
      context.addIssue({
        code: "custom",
        message: "A guild event requires a guild ID.",
        path: ["guildId"],
      });
    }
  });

export type DiscordAccessEvent = z.infer<typeof DiscordAccessEventSchema>;

export type GateDecision =
  | { readonly action: "deliver" }
  | { readonly action: "drop"; readonly reason: string }
  | { readonly action: "pair"; readonly code: string; readonly expiresAt: number };

export interface DiscordAccessEvaluation {
  readonly bot: BotCredentialMetadata;
  readonly policy: AccessPolicy;
  readonly event: DiscordAccessEvent;
  readonly now: number;
  readonly createPairingCode?: () => string;
  readonly maxPendingPairings?: number;
}

const DELIVER: GateDecision = Object.freeze({ action: "deliver" });

function drop(reason: string): GateDecision {
  return Object.freeze({ action: "drop", reason });
}

function configuredPendingLimit(value: number | undefined): number | undefined {
  const limit = value ?? DEFAULT_MAX_PENDING_PAIRINGS;
  return Number.isSafeInteger(limit) && limit > 0 && limit <= MAX_PENDING_PAIRINGS
    ? limit
    : undefined;
}

function parseEvaluation(input: DiscordAccessEvaluation):
  | {
      bot: BotCredentialMetadata;
      policy: AccessPolicy;
      event: DiscordAccessEvent;
      now: number;
      maxPendingPairings: number;
    }
  | undefined {
  if (typeof input !== "object" || input === null) {
    return undefined;
  }
  const parsedBot = BotCredentialMetadataSchema.safeParse(input.bot);
  const parsedPolicy = AccessPolicySchema.safeParse(input.policy);
  const parsedEvent = DiscordAccessEventSchema.safeParse(input.event);
  const maxPendingPairings = configuredPendingLimit(input.maxPendingPairings);
  if (
    !parsedBot.success ||
    !parsedPolicy.success ||
    !parsedEvent.success ||
    !Number.isSafeInteger(input.now) ||
    input.now < 0 ||
    maxPendingPairings === undefined
  ) {
    return undefined;
  }
  return {
    bot: parsedBot.data,
    policy: parsedPolicy.data,
    event: parsedEvent.data,
    now: input.now,
    maxPendingPairings,
  };
}

function activePairingExpiry(expiresAt: string, now: number): number | undefined {
  const expiry = Date.parse(expiresAt);
  return Number.isFinite(expiry) && expiry > now ? expiry : undefined;
}

function pairingDecision(
  input: DiscordAccessEvaluation,
  policy: AccessPolicy,
  event: DiscordAccessEvent,
  now: number,
  maxPendingPairings: number,
): GateDecision {
  let activeCount = 0;
  for (const [code, pairing] of Object.entries(policy.pendingPairings)) {
    const expiresAt = activePairingExpiry(pairing.expiresAt, now);
    if (expiresAt === undefined) {
      continue;
    }
    activeCount += 1;
    if (pairing.senderId === event.senderId && pairing.dmChannelId === event.channelId) {
      return Object.freeze({ action: "pair", code, expiresAt });
    }
  }
  if (activeCount >= maxPendingPairings) {
    return drop("pairing-capacity");
  }

  let code: unknown;
  try {
    code = input.createPairingCode?.();
  } catch {
    return drop("invalid-pairing-code");
  }
  const parsedCode = PairingCodeSchema.safeParse(code);
  if (!parsedCode.success || Object.hasOwn(policy.pendingPairings, parsedCode.data)) {
    return drop("invalid-pairing-code");
  }
  return Object.freeze({
    action: "pair",
    code: parsedCode.data,
    expiresAt: now + PAIRING_TTL_MS,
  });
}

function evaluatesMention(policy: AccessPolicy, event: DiscordAccessEvent): boolean {
  return (
    event.mentionsBot ||
    policy.mentionPatterns.some((literal) => literal.length > 0 && event.content.includes(literal))
  );
}

export function evaluateDiscordAccess(input: DiscordAccessEvaluation): GateDecision {
  const parsed = parseEvaluation(input);
  if (parsed === undefined) {
    return drop("invalid-access-input");
  }
  const { bot, policy, event, now, maxPendingPairings } = parsed;
  if (event.senderIsBot || event.senderIsSystem || event.senderId === bot.botUserId) {
    return drop("automated-sender");
  }

  if (event.kind !== "message") {
    if (event.senderId !== bot.ownerUserId) {
      return drop("owner-only");
    }
    if (bot.ownerConfirmedAt === undefined) {
      return drop("owner-not-confirmed");
    }
    if (event.location !== "dm") {
      const policyChannelId = event.location === "thread" ? event.parentChannelId : event.channelId;
      if (policyChannelId === undefined || !Object.hasOwn(policy.groups, policyChannelId)) {
        return drop("channel-not-allowed");
      }
    }
    return DELIVER;
  }

  if (event.location === "dm") {
    if (event.senderId === bot.ownerUserId) {
      return DELIVER;
    }
    if (policy.dmPolicy === "disabled") {
      return drop("dm-disabled");
    }
    if (policy.allowFrom.includes(event.senderId)) {
      return DELIVER;
    }
    if (policy.dmPolicy === "allowlist") {
      return drop("dm-not-allowed");
    }
    return pairingDecision(input, policy, event, now, maxPendingPairings);
  }

  const policyChannelId = event.location === "thread" ? event.parentChannelId : event.channelId;
  if (policyChannelId === undefined || !Object.hasOwn(policy.groups, policyChannelId)) {
    return drop("channel-not-allowed");
  }
  const group = policy.groups[policyChannelId];
  if (group === undefined) {
    return drop("channel-not-allowed");
  }
  if (group.allowFrom.length > 0 && !group.allowFrom.includes(event.senderId)) {
    return drop("sender-not-allowed");
  }
  if (group.requireMention && !evaluatesMention(policy, event)) {
    return drop("mention-required");
  }
  return DELIVER;
}
