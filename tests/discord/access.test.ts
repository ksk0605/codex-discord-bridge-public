import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MAX_PENDING_PAIRINGS,
  evaluateDiscordAccess,
  PAIRING_TTL_MS,
} from "../../src/discord/access.js";
import type { AccessPolicy, BotCredentialMetadata } from "../../src/domain/schemas.js";

const OWNER = "100000000000000001";
const USER = "100000000000000002";
const OTHER = "100000000000000003";
const BOT = "100000000000000004";
const DM = "200000000000000001";
const CHANNEL = "200000000000000002";
const THREAD = "200000000000000003";
const NOW = Date.parse("2026-07-28T00:00:00.000Z");

function bot(overrides: Partial<BotCredentialMetadata> = {}): BotCredentialMetadata {
  return {
    name: "bot-one",
    applicationId: "300000000000000001",
    botUserId: BOT,
    keychainAccount: "bot-one",
    ownerUserId: OWNER,
    state: "registered",
    ...overrides,
  };
}

function policy(overrides: Partial<AccessPolicy> = {}): AccessPolicy {
  return {
    dmPolicy: "pairing",
    allowFrom: [OWNER],
    groups: {},
    pendingPairings: {},
    mentionPatterns: ["@codex"],
    ackReaction: "ok",
    replyToMode: "first",
    textChunkLimit: 2_000,
    chunkMode: "length",
    ...overrides,
  };
}

const dmMessage = {
  kind: "message" as const,
  location: "dm" as const,
  senderId: USER,
  channelId: DM,
  content: "hello",
  mentionsBot: false,
};

describe("evaluateDiscordAccess", () => {
  it("drops bot and system senders before any pairing work", () => {
    const createPairingCode = vi.fn(() => "PAIR-ONE");

    expect(
      evaluateDiscordAccess({
        bot: bot(),
        policy: policy(),
        event: { ...dmMessage, senderIsBot: true },
        now: NOW,
        createPairingCode,
      }),
    ).toEqual({ action: "drop", reason: "automated-sender" });
    expect(
      evaluateDiscordAccess({
        bot: bot(),
        policy: policy(),
        event: { ...dmMessage, senderIsSystem: true },
        now: NOW,
        createPairingCode,
      }),
    ).toEqual({ action: "drop", reason: "automated-sender" });
    expect(createPairingCode).not.toHaveBeenCalled();
  });

  it("allows the exact owner DM bootstrap but keeps admin actions locked until confirmed", () => {
    const unconfirmed = bot();
    const ownerDm = { ...dmMessage, senderId: OWNER };

    expect(
      evaluateDiscordAccess({ bot: unconfirmed, policy: policy(), event: ownerDm, now: NOW }),
    ).toEqual({ action: "deliver" });
    expect(
      evaluateDiscordAccess({
        bot: unconfirmed,
        policy: policy(),
        event: { ...ownerDm, kind: "command" },
        now: NOW,
      }),
    ).toEqual({ action: "drop", reason: "owner-not-confirmed" });
    expect(
      evaluateDiscordAccess({
        bot: bot({ ownerConfirmedAt: "2026-07-27T00:00:00.000Z" }),
        policy: policy(),
        event: { ...ownerDm, kind: "approval" },
        now: NOW,
      }),
    ).toEqual({ action: "deliver" });
  });

  it("restricts commands and approvals to the confirmed owner", () => {
    const confirmed = bot({ ownerConfirmedAt: "2026-07-27T00:00:00.000Z" });

    for (const kind of ["command", "approval"] as const) {
      expect(
        evaluateDiscordAccess({
          bot: confirmed,
          policy: policy({ allowFrom: [OWNER, USER] }),
          event: { ...dmMessage, kind },
          now: NOW,
        }),
      ).toEqual({ action: "drop", reason: "owner-only" });
    }
  });

  it("requires confirmed-owner administrative events to use an allowed guild channel", () => {
    const confirmed = bot({ ownerConfirmedAt: "2026-07-27T00:00:00.000Z" });
    const command = {
      ...dmMessage,
      kind: "command" as const,
      location: "guild" as const,
      senderId: OWNER,
      channelId: CHANNEL,
      guildId: "500000000000000001",
    };

    expect(
      evaluateDiscordAccess({ bot: confirmed, policy: policy(), event: command, now: NOW }),
    ).toEqual({ action: "drop", reason: "channel-not-allowed" });
    expect(
      evaluateDiscordAccess({
        bot: confirmed,
        policy: policy({ groups: { [CHANNEL]: { requireMention: true, allowFrom: [] } } }),
        event: command,
        now: NOW,
      }),
    ).toEqual({ action: "deliver" });
  });

  it("enforces disabled and allowlist DM modes", () => {
    expect(
      evaluateDiscordAccess({
        bot: bot(),
        policy: policy({ dmPolicy: "disabled", allowFrom: [OWNER, USER] }),
        event: dmMessage,
        now: NOW,
      }),
    ).toEqual({ action: "drop", reason: "dm-disabled" });
    expect(
      evaluateDiscordAccess({
        bot: bot(),
        policy: policy({ dmPolicy: "allowlist", allowFrom: [OWNER, USER] }),
        event: dmMessage,
        now: NOW,
      }),
    ).toEqual({ action: "deliver" });
    expect(
      evaluateDiscordAccess({
        bot: bot(),
        policy: policy({ dmPolicy: "allowlist" }),
        event: dmMessage,
        now: NOW,
      }),
    ).toEqual({ action: "drop", reason: "dm-not-allowed" });
  });

  it("creates one-hour pairings without mutating policy or ownership", () => {
    const access = policy();
    const credential = bot();
    const before = structuredClone({ access, credential });

    expect(
      evaluateDiscordAccess({
        bot: credential,
        policy: access,
        event: dmMessage,
        now: NOW,
        createPairingCode: () => "PAIR-ONE",
      }),
    ).toEqual({ action: "pair", code: "PAIR-ONE", expiresAt: NOW + PAIRING_TTL_MS });
    expect({ access, credential }).toEqual(before);
    expect(credential.ownerUserId).toBe(OWNER);
  });

  it("reuses an active pairing and ignores expired entries for capacity", () => {
    const existingExpiry = new Date(NOW + 10_000).toISOString();
    const expired = new Date(NOW - 1).toISOString();
    const createPairingCode = vi.fn(() => "PAIR-NEW");
    const existingPolicy = policy({
      pendingPairings: {
        existing: {
          senderId: USER,
          dmChannelId: DM,
          createdAt: new Date(NOW - 1_000).toISOString(),
          expiresAt: existingExpiry,
          replyCount: 0,
        },
      },
    });

    expect(
      evaluateDiscordAccess({
        bot: bot(),
        policy: existingPolicy,
        event: dmMessage,
        now: NOW,
        createPairingCode,
      }),
    ).toEqual({ action: "pair", code: "existing", expiresAt: Date.parse(existingExpiry) });
    expect(createPairingCode).not.toHaveBeenCalled();

    const expiredEntries = Object.fromEntries(
      Array.from({ length: DEFAULT_MAX_PENDING_PAIRINGS }, (_, index) => [
        `expired-${String(index)}`,
        {
          senderId: OTHER,
          dmChannelId: DM,
          createdAt: new Date(NOW - 20_000).toISOString(),
          expiresAt: expired,
          replyCount: 0,
        },
      ]),
    );
    expect(
      evaluateDiscordAccess({
        bot: bot(),
        policy: policy({ pendingPairings: expiredEntries }),
        event: dmMessage,
        now: NOW,
        createPairingCode,
      }),
    ).toEqual({ action: "pair", code: "PAIR-NEW", expiresAt: NOW + PAIRING_TTL_MS });
  });

  it("drops new pairing requests at the active pending limit", () => {
    const pendingPairings = Object.fromEntries(
      Array.from({ length: DEFAULT_MAX_PENDING_PAIRINGS }, (_, index) => [
        `active-${String(index)}`,
        {
          senderId: OTHER,
          dmChannelId: String(4_000_000_000_000_000_000n + BigInt(index)),
          createdAt: new Date(NOW - 1_000).toISOString(),
          expiresAt: new Date(NOW + 10_000).toISOString(),
          replyCount: 0,
        },
      ]),
    );

    expect(
      evaluateDiscordAccess({
        bot: bot(),
        policy: policy({ pendingPairings }),
        event: dmMessage,
        now: NOW,
        createPairingCode: () => "PAIR-NEW",
      }),
    ).toEqual({ action: "drop", reason: "pairing-capacity" });
  });

  it("requires an explicit guild channel and inherits only a thread parent policy", () => {
    const groups = { [CHANNEL]: { requireMention: false, allowFrom: [] } };
    const guildMessage = {
      ...dmMessage,
      location: "guild" as const,
      channelId: CHANNEL,
      guildId: "500000000000000001",
    };

    expect(
      evaluateDiscordAccess({
        bot: bot(),
        policy: policy({ groups }),
        event: guildMessage,
        now: NOW,
      }),
    ).toEqual({ action: "deliver" });
    expect(
      evaluateDiscordAccess({
        bot: bot(),
        policy: policy({ groups }),
        event: { ...guildMessage, channelId: OTHER },
        now: NOW,
      }),
    ).toEqual({ action: "drop", reason: "channel-not-allowed" });
    expect(
      evaluateDiscordAccess({
        bot: bot(),
        policy: policy({ groups }),
        event: {
          ...guildMessage,
          location: "thread",
          channelId: THREAD,
          parentChannelId: CHANNEL,
        },
        now: NOW,
      }),
    ).toEqual({ action: "deliver" });
    expect(
      evaluateDiscordAccess({
        bot: bot(),
        policy: policy({ groups: { [THREAD]: groups[CHANNEL] } }),
        event: {
          ...guildMessage,
          location: "thread",
          channelId: THREAD,
          parentChannelId: OTHER,
        },
        now: NOW,
      }),
    ).toEqual({ action: "drop", reason: "channel-not-allowed" });
  });

  it("enforces channel sender and literal mention requirements", () => {
    const configured = policy({
      groups: { [CHANNEL]: { requireMention: true, allowFrom: [USER] } },
      mentionPatterns: ["[codex]"],
    });
    const event = {
      ...dmMessage,
      location: "guild" as const,
      channelId: CHANNEL,
      guildId: "500000000000000001",
    };

    expect(evaluateDiscordAccess({ bot: bot(), policy: configured, event, now: NOW })).toEqual({
      action: "drop",
      reason: "mention-required",
    });
    expect(
      evaluateDiscordAccess({
        bot: bot(),
        policy: configured,
        event: { ...event, content: "please [codex] answer" },
        now: NOW,
      }),
    ).toEqual({ action: "deliver" });
    expect(
      evaluateDiscordAccess({
        bot: bot(),
        policy: configured,
        event: { ...event, content: "hello", mentionsBot: true },
        now: NOW,
      }),
    ).toEqual({ action: "deliver" });
    expect(
      evaluateDiscordAccess({
        bot: bot(),
        policy: configured,
        event: { ...event, senderId: OTHER, content: "[codex]" },
        now: NOW,
      }),
    ).toEqual({ action: "drop", reason: "sender-not-allowed" });
  });

  it("fails closed on malformed external input and duplicate generated codes", () => {
    expect(
      evaluateDiscordAccess({
        bot: bot(),
        policy: policy(),
        event: { ...dmMessage, senderId: "not-an-id" },
        now: NOW,
        createPairingCode: () => "PAIR-ONE",
      }),
    ).toEqual({ action: "drop", reason: "invalid-access-input" });
    expect(
      evaluateDiscordAccess({
        bot: bot(),
        policy: policy({
          pendingPairings: {
            duplicate: {
              senderId: OTHER,
              dmChannelId: DM,
              createdAt: new Date(NOW - 1_000).toISOString(),
              expiresAt: new Date(NOW + 1_000).toISOString(),
              replyCount: 0,
            },
          },
        }),
        event: dmMessage,
        now: NOW,
        createPairingCode: () => "duplicate",
      }),
    ).toEqual({ action: "drop", reason: "invalid-pairing-code" });
  });
});
