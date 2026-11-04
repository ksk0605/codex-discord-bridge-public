import { describe, expect, it, vi } from "vitest";
import {
  type DiscordAgentRuntime,
  DiscordGatewayAdapter,
  type DiscordGatewayTransport,
  InjectedTurnRejectedError,
} from "../../src/discord/adapter.js";
import type { TurnInput } from "../../src/runtime/turn-queue.js";

const CHANNEL = "200000000000000001";
const GUILD = "300000000000000001";
const POSTED = "600000000000000001";
const BOT_USER = "100000000000000002";

function fixture() {
  const sent: Array<{ channelId: string; content: string; replyToMessageId?: string }> = [];
  const calls: string[] = [];
  const transport = {
    onMessage: vi.fn(() => vi.fn()),
    onCommand: vi.fn(() => vi.fn()),
    onButton: vi.fn(() => vi.fn()),
    login: vi.fn(async () => undefined),
    destroy: vi.fn(async () => undefined),
    sendTyping: vi.fn(async () => undefined),
    sendMessage: vi.fn(
      async (channelId: string, payload: { content: string; replyToMessageId?: string }) => {
        calls.push("post");
        sent.push({ channelId, ...payload });
        return { id: POSTED, guildId: GUILD };
      },
    ),
  } as unknown as DiscordGatewayTransport;
  const enqueue = vi.fn((_input: TurnInput): Promise<void> => {
    calls.push("enqueue");
    return Promise.resolve();
  });
  const runtime = {
    state: "running",
    queue: { depth: () => 0 },
    enqueue,
    interrupt: vi.fn(async () => undefined),
  } as unknown as DiscordAgentRuntime;
  const errors: unknown[] = [];
  const adapter = new DiscordGatewayAdapter({
    botName: "bot-one",
    transport,
    registry: {
      read: vi.fn(),
      updateAccess: vi.fn(),
      confirmOwner: vi.fn(),
    } as never,
    runtime,
    manager: {} as never,
    approval: { handleInteraction: vi.fn(() => false) },
    onError: (error) => errors.push(error),
  });
  return { adapter, transport, enqueue, sent, calls, errors };
}

const turn = { channelId: CHANNEL, authorId: BOT_USER, text: "[marker]\n아침 브리핑" };

describe("DiscordGatewayAdapter.injectTurn", () => {
  it("refuses before login", async () => {
    const context = fixture();

    await expect(context.adapter.injectTurn(turn)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(context.sent).toEqual([]);
  });

  it("posts the turn, then enqueues it as a reply source with the posted guild", async () => {
    const context = fixture();
    await context.adapter.start("token");

    const receipt = await context.adapter.injectTurn(turn);

    expect(receipt).toEqual({ messageId: POSTED, guildId: GUILD });
    expect(context.sent[0]).toEqual({ channelId: CHANNEL, content: turn.text });
    expect(context.enqueue).toHaveBeenCalledWith({
      channelId: CHANNEL,
      messageId: POSTED,
      authorId: BOT_USER,
      guildId: GUILD,
      text: turn.text,
    });
  });

  it("runs beforeEnqueue between posting and enqueuing", async () => {
    const context = fixture();
    await context.adapter.start("token");

    await context.adapter.injectTurn({
      ...turn,
      beforeEnqueue: async () => {
        context.calls.push("before");
      },
    });

    expect(context.calls).toEqual(["post", "before", "enqueue"]);
  });

  it("answers in the channel and rethrows when the runtime refuses the turn", async () => {
    const context = fixture();
    await context.adapter.start("token");
    context.enqueue.mockImplementationOnce(() => {
      throw new Error("not accepting");
    });

    await expect(context.adapter.injectTurn(turn)).rejects.toBeInstanceOf(
      InjectedTurnRejectedError,
    );

    expect(context.sent[1]).toMatchObject({
      channelId: CHANNEL,
      replyToMessageId: POSTED,
      content: expect.stringContaining("처리하지 못했습니다"),
    });
    expect(context.errors).toHaveLength(1);
  });

  it("answers in the channel when the queued turn later fails", async () => {
    const context = fixture();
    await context.adapter.start("token");
    context.enqueue.mockImplementationOnce(() => Promise.reject(new Error("discarded")));

    await context.adapter.injectTurn(turn);

    await vi.waitFor(() =>
      expect(context.sent[1]).toMatchObject({
        replyToMessageId: POSTED,
        content: expect.stringContaining("처리하지 못했습니다"),
      }),
    );
    expect(context.errors).toHaveLength(1);
  });

  it("waits for a pending injected turn's failure handling when stopping", async () => {
    const context = fixture();
    await context.adapter.start("token");
    let reject!: (error: unknown) => void;
    context.enqueue.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, rejectPromise) => {
          reject = rejectPromise;
        }),
    );
    await context.adapter.injectTurn(turn);

    const stopping = context.adapter.stop();
    reject(new Error("stopped"));
    await stopping;

    expect(context.sent.some((message) => message.replyToMessageId === POSTED)).toBe(true);
  });

  it("does not mark a failed post as posted", async () => {
    const context = fixture();
    await context.adapter.start("token");
    vi.mocked(context.transport.sendMessage).mockRejectedValueOnce(new Error("no permission"));

    const error = await context.adapter.injectTurn(turn).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(InjectedTurnRejectedError);
  });

  it("makes stop wait for an injected turn that is still being posted", async () => {
    const context = fixture();
    await context.adapter.start("token");
    let finishPost!: () => void;
    vi.mocked(context.transport.sendMessage).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishPost = () => resolve({ id: POSTED, guildId: GUILD });
        }),
    );
    const injecting = context.adapter.injectTurn(turn).catch(() => undefined);
    await Promise.resolve();

    let stopped = false;
    const stopping = context.adapter.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stopped).toBe(false);

    finishPost();
    await injecting;
    await stopping;
    expect(stopped).toBe(true);
    expect(vi.mocked(context.transport.destroy)).toHaveBeenCalledOnce();
    // The failure reply went out before the transport was destroyed.
    expect(context.sent.some((message) => message.replyToMessageId === POSTED)).toBe(true);
  });
});
