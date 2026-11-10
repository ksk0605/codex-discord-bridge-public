import { describe, expect, it, vi } from "vitest";
import { type DiscordInjectedTurn, InjectedTurnRejectedError } from "../../src/discord/adapter.js";
import { InjectGuard } from "../../src/inject/guard.js";
import {
  INJECT_MARKER,
  InjectService,
  type InjectServiceOptions,
} from "../../src/inject/service.js";

const BOT_USER = "100000000000000001";
const CHANNEL = "100000000000000010";
const OTHER_CHANNEL = "100000000000000011";
const LOG_CHANNEL = "100000000000000020";
const GUILD = "100000000000000030";
const POSTED = "50100000000000000";

function fixture(overrides: Partial<InjectServiceOptions> = {}) {
  const calls: string[] = [];
  const turns: DiscordInjectedTurn[] = [];
  let accepting = true;
  const injectTurn = vi.fn(async (turn: DiscordInjectedTurn) => {
    calls.push(`post:${turn.channelId}`);
    turns.push(turn);
    await turn.beforeEnqueue?.();
    calls.push("enqueue");
    return { messageId: POSTED, guildId: GUILD };
  });
  const interrupt = vi.fn(async () => {
    calls.push("interrupt");
  });
  const sendMessage = vi.fn(async (_channelId: string, _payload: { content: string }) => ({
    id: "50200000000000000",
  }));
  const errors: unknown[] = [];
  const service = new InjectService({
    botName: "check",
    guard: new InjectGuard({ now: () => 1_000_000 }),
    snapshot: async () => ({ botUserId: BOT_USER, channelIds: [CHANNEL] }),
    agent: { acceptingTurns: () => accepting, injectTurn, interrupt },
    log: { sendMessage },
    config: { logChannelId: LOG_CHANNEL },
    onError: (error: unknown) => errors.push(error),
    ...overrides,
  });
  return {
    service,
    injectTurn,
    interrupt,
    sendMessage,
    calls,
    turns,
    errors,
    stopAccepting: () => {
      accepting = false;
    },
  };
}

const request = (extra: Record<string, unknown> = {}) => ({
  version: 1,
  text: "아침 브리핑 만들어서 올려",
  from: "cron:morning",
  ...extra,
});

describe("InjectService", () => {
  it("hands the marked text to the agent as the bot's own turn in the bound channel", async () => {
    const context = fixture();

    const response = await context.service.handle(request());

    expect(response).toEqual({ ok: true, channelId: CHANNEL, messageId: POSTED });
    const turn = context.turns[0];
    expect(turn?.channelId).toBe(CHANNEL);
    expect(turn?.authorId).toBe(BOT_USER);
    expect(turn?.text.startsWith(INJECT_MARKER)).toBe(true);
    expect(turn?.text).toContain("보낸 쪽: cron:morning");
    expect(turn?.text).toContain("아침 브리핑 만들어서 올려");
  });

  it("tells the receiving agent which hop to use when it passes work on", async () => {
    const context = fixture();

    await context.service.handle(request({ hop: 1 }));

    expect(context.turns[0]?.text).toContain("hop 1");
    expect(context.turns[0]?.text).toContain("--hop 2");
  });

  it("writes one log line linking to the posted message", async () => {
    const context = fixture();

    await context.service.handle(request());

    expect(context.sendMessage).toHaveBeenCalledOnce();
    const [channelId, payload] = context.sendMessage.mock.calls[0] ?? [];
    expect(channelId).toBe(LOG_CHANNEL);
    expect(payload?.content).toContain("cron:morning → check");
    expect(payload?.content).toContain("대기열");
    expect(payload?.content).toContain(
      `https://discord.com/channels/${GUILD}/${CHANNEL}/${POSTED}`,
    );
  });

  it("skips the log line when no log channel is configured", async () => {
    const context = fixture({ config: {} });

    await context.service.handle(request());

    expect(context.sendMessage).not.toHaveBeenCalled();
  });

  it("interrupts the active turn after posting and before enqueuing in interrupt mode", async () => {
    const context = fixture();

    await context.service.handle(request({ mode: "interrupt" }));

    expect(context.calls).toEqual([`post:${CHANNEL}`, "interrupt", "enqueue"]);
  });

  it("does not interrupt in queue mode", async () => {
    const context = fixture();

    await context.service.handle(request());

    expect(context.interrupt).not.toHaveBeenCalled();
  });

  it("rejects malformed requests without touching Discord", async () => {
    const context = fixture();

    for (const bad of [
      null,
      "text",
      request({ version: 2 }),
      request({ text: "" }),
      request({ text: "x".repeat(1_501) }),
      request({ from: "" }),
      request({ from: "has space" }),
      request({ mode: "later" }),
      request({ extra: true }),
    ]) {
      const response = await context.service.handle(bad);
      expect(response).toMatchObject({ ok: false, code: "INVALID_REQUEST" });
    }
    expect(context.injectTurn).not.toHaveBeenCalled();
  });

  it("rejects requests the guard blocks", async () => {
    const context = fixture();

    expect((await context.service.handle(request())).ok).toBe(true);
    const response = await context.service.handle(request());

    expect(response).toMatchObject({ ok: false, code: "RATE_LIMITED", reason: "sender-cooldown" });
    expect(context.injectTurn).toHaveBeenCalledTimes(1);
  });

  it("uses an explicitly requested channel only when the bot is bound to it", async () => {
    const context = fixture({
      snapshot: async () => ({ botUserId: BOT_USER, channelIds: [CHANNEL, OTHER_CHANNEL] }),
    });

    const allowed = await context.service.handle(request({ channelId: OTHER_CHANNEL }));
    const denied = await context.service.handle(
      request({ from: "hub:task-2", channelId: "100000000000000099" }),
    );

    expect(allowed).toMatchObject({ ok: true, channelId: OTHER_CHANNEL });
    expect(denied).toMatchObject({ ok: false, code: "CHANNEL_NOT_ALLOWED" });
  });

  it("passes an allowed announce channel to the agent and names it in the log line", async () => {
    const ANNOUNCE = "100000000000000040";
    const context = fixture({
      config: { logChannelId: LOG_CHANNEL, announceChannelIds: [ANNOUNCE] },
    });

    const response = await context.service.handle(request({ announceChannelId: ANNOUNCE }));

    expect(response).toMatchObject({ ok: true, channelId: CHANNEL });
    expect(context.turns[0]?.announceChannelId).toBe(ANNOUNCE);
    expect(context.sendMessage.mock.calls[0]?.[1]?.content).toContain(`결과 → <#${ANNOUNCE}>`);
  });

  it("asks for a fresh Codex thread only when the request says so, and logs it", async () => {
    const context = fixture({ config: { logChannelId: LOG_CHANNEL } });

    await context.service.handle(request({ newThread: true }));
    await context.service.handle(request({ from: "hub:task-2" }));

    expect(context.turns[0]?.freshThread).toBe(true);
    expect(context.turns[1]?.freshThread).toBeUndefined();
    expect(context.sendMessage.mock.calls[0]?.[1]?.content).toContain("새 스레드");
    expect(context.sendMessage.mock.calls[1]?.[1]?.content).not.toContain("새 스레드");
  });

  it("refuses an announce channel that is not allowed, before posting anything", async () => {
    const context = fixture({ config: { announceChannelIds: ["100000000000000040"] } });

    const response = await context.service.handle(
      request({ announceChannelId: "100000000000000041" }),
    );

    expect(response).toMatchObject({ ok: false, code: "ANNOUNCE_NOT_ALLOWED" });
    expect(context.injectTurn).not.toHaveBeenCalled();
  });

  it("refuses announcing when no announce channels are configured", async () => {
    const context = fixture();

    expect(
      await context.service.handle(request({ announceChannelId: "100000000000000040" })),
    ).toMatchObject({ ok: false, code: "ANNOUNCE_NOT_ALLOWED" });
  });

  it("ignores an announce channel that is the turn's own channel", async () => {
    const context = fixture();

    const response = await context.service.handle(request({ announceChannelId: CHANNEL }));

    expect(response).toMatchObject({ ok: true });
    expect(context.turns[0]).not.toHaveProperty("announceChannelId");
  });

  it("requires a channel when the bot is bound to several", async () => {
    const context = fixture({
      snapshot: async () => ({ botUserId: BOT_USER, channelIds: [CHANNEL, OTHER_CHANNEL] }),
    });

    expect(await context.service.handle(request())).toMatchObject({
      ok: false,
      code: "CHANNEL_REQUIRED",
    });
  });

  it("refuses before posting when the agent is not accepting turns", async () => {
    const context = fixture();
    context.stopAccepting();

    const response = await context.service.handle(request());

    expect(response).toMatchObject({ ok: false, code: "UNAVAILABLE" });
    expect(context.injectTurn).not.toHaveBeenCalled();
  });

  it("reports a failed delivery and gives the sender's slot back", async () => {
    const context = fixture();
    context.injectTurn.mockRejectedValueOnce(new Error("send permission missing"));

    const failed = await context.service.handle(request());
    const retried = await context.service.handle(request());

    expect(failed).toMatchObject({ ok: false, code: "UNAVAILABLE" });
    expect(context.errors).toHaveLength(1);
    expect(retried.ok).toBe(true);
  });

  it("keeps the slot spent when the turn was already posted before it was refused", async () => {
    const context = fixture();
    context.injectTurn.mockRejectedValueOnce(
      new InjectedTurnRejectedError("50100000000000000", new Error("interrupt failed")),
    );

    const failed = await context.service.handle(request({ mode: "interrupt" }));
    const retried = await context.service.handle(request({ mode: "interrupt" }));

    expect(failed).toMatchObject({ ok: false, code: "UNAVAILABLE" });
    expect(retried).toMatchObject({ ok: false, code: "RATE_LIMITED" });
  });

  it("answers an internal failure generically and reports it", async () => {
    const context = fixture({
      snapshot: async () => {
        throw new Error("registry unreadable");
      },
    });

    const response = await context.service.handle(request());

    expect(response).toEqual({ ok: false, code: "INTERNAL", message: "Inject request failed." });
    expect(context.errors).toHaveLength(1);
  });

  it("still succeeds when the log line cannot be written", async () => {
    const context = fixture();
    context.sendMessage.mockRejectedValueOnce(new Error("log channel missing"));

    const response = await context.service.handle(request());

    expect(response.ok).toBe(true);
    expect(context.errors).toHaveLength(1);
  });
});
