import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DiscordProgressController,
  type DiscordProgressControllerSource,
  type DiscordProgressTransport,
  type ProgressObservationJournalPort,
} from "../../src/discord/progress-controller.js";
import type { RenderedProgressEvent } from "../../src/discord/progress-format.js";
import {
  AtomicProgressObservationJournal,
  type ProgressObservationRecord,
} from "../../src/discord/progress-journal.js";
import type {
  ProgressPump,
  ProgressPumpDestination,
  RenderedTerminal,
} from "../../src/discord/progress-pump.js";
import { BridgeError } from "../../src/domain/errors.js";
import type {
  DiscordDeliveryReceipt,
  TurnProgressSource,
} from "../../src/runtime/turn-progress.js";

const NOW = "2026-07-31T00:00:00.000Z";
const LATER = "2026-07-31T00:01:00.000Z";
const BOT = "100000000000000001";
const OWNER = "100000000000000002";
const GUILD = "200000000000000001";
const CHANNEL = "300000000000000001";
const USER_THREAD = "300000000000000002";
const MESSAGE = "400000000000000001";
const SECOND_MESSAGE = "400000000000000002";
const THIRD_MESSAGE = "400000000000000003";
const FOURTH_MESSAGE = "400000000000000004";
const STATUS_MESSAGE = "500000000000000001";
const RESPONSE_MESSAGE = "500000000000000002";
const TURN = "60000000-0000-4000-8000-000000000001";

let temporaryDirectory: string;
let journal: AtomicProgressObservationJournal;

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function guildSource(messageId = MESSAGE): DiscordProgressControllerSource {
  return {
    channelId: CHANNEL,
    guildId: GUILD,
    location: "guild",
    messageId,
  };
}

function dmSource(messageId = MESSAGE): DiscordProgressControllerSource {
  return {
    channelId: CHANNEL,
    location: "dm",
    messageId,
  };
}

function userThreadSource(messageId = MESSAGE): DiscordProgressControllerSource {
  return {
    channelId: USER_THREAD,
    guildId: GUILD,
    location: "thread",
    messageId,
    parentChannelId: CHANNEL,
    threadOwnerId: OWNER,
  };
}

function turnSource(source: TurnProgressSource): TurnProgressSource {
  return {
    channelId: source.channelId,
    ...(source.guildId === undefined ? {} : { guildId: source.guildId }),
    messageId: source.messageId,
  };
}

function progressThreadEvent(
  channelId = MESSAGE,
  overrides: Partial<{
    location: "dm" | "guild" | "thread";
    parentChannelId: string;
    threadOwnerId: string;
  }> = {},
) {
  return {
    channelId,
    location: "thread" as const,
    parentChannelId: CHANNEL,
    threadOwnerId: BOT,
    ...overrides,
  };
}

function journalPort(
  value: AtomicProgressObservationJournal,
  overrides: Partial<ProgressObservationJournalPort> = {},
): ProgressObservationJournalPort {
  return {
    initialize: value.initialize.bind(value),
    beginCreation: value.beginCreation.bind(value),
    confirmDestination: value.confirmDestination.bind(value),
    markPreparing: value.markPreparing.bind(value),
    markQueued: value.markQueued.bind(value),
    markRunning: value.markRunning.bind(value),
    beginDelivery: value.beginDelivery.bind(value),
    acceptDelivery: value.acceptDelivery.bind(value),
    markDeliveryUncertain: value.markDeliveryUncertain.bind(value),
    markDeliveryFailed: value.markDeliveryFailed.bind(value),
    close: value.close.bind(value),
    get: value.get.bind(value),
    isProgressThread: value.isProgressThread.bind(value),
    listActive: value.listActive.bind(value),
    listTerminalTombstones: value.listTerminalTombstones.bind(value),
    listRequestedTombstoneReconciliations: value.listRequestedTombstoneReconciliations.bind(value),
    removeDeletedThreadTombstone: value.removeDeletedThreadTombstone.bind(value),
    ...overrides,
  };
}

interface TestTransport extends DiscordProgressTransport {
  createProgressThread: ReturnType<typeof vi.fn>;
  editMessage: ReturnType<typeof vi.fn>;
  inspectProgressCapabilities: ReturnType<typeof vi.fn>;
  inspectThread: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
  setProgressThreadState: ReturnType<typeof vi.fn>;
}

function transport(): TestTransport {
  let sent = 0;
  return {
    createProgressThread: vi.fn(async (channelId: string, sourceMessageId: string) => ({
      id: sourceMessageId,
      ownerId: BOT,
      parentId: channelId,
    })),
    editMessage: vi.fn(async (_channelId: string, messageId: string) => ({ id: messageId })),
    inspectProgressCapabilities: vi.fn(async () => ({
      createPublicThreads: true,
      manageThreads: true,
      sendMessagesInThreads: true,
    })),
    inspectThread: vi.fn(async (threadId: string) => ({
      archived: false,
      id: threadId,
      locked: false,
      ownerId: BOT,
      parentId: CHANNEL,
      status: "found" as const,
    })),
    sendMessage: vi.fn(async () => {
      sent += 1;
      return { id: String(BigInt(STATUS_MESSAGE) + BigInt(sent - 1)) };
    }),
    setProgressThreadState: vi.fn(async () => undefined),
  };
}

class ImmediatePump implements ProgressPump {
  readonly events: RenderedProgressEvent[] = [];
  readonly heartbeats: number[] = [];
  readonly terminals: RenderedTerminal[] = [];
  readonly destination: ProgressPumpDestination;
  statusMessageId: string | undefined;
  stopped = false;

  constructor(destination: ProgressPumpDestination) {
    this.destination = destination;
  }

  async start(initialStatus: string): Promise<void> {
    try {
      this.statusMessageId = (
        await this.destination.createStatus(initialStatus, new AbortController().signal)
      ).id;
    } catch {
      // Matches the production pump's best-effort start contract.
    }
  }

  async push(event: RenderedProgressEvent): Promise<void> {
    this.events.push(event);
  }

  async heartbeat(observedAt: number): Promise<void> {
    this.heartbeats.push(observedAt);
  }

  async terminal(status: RenderedTerminal): Promise<void> {
    this.terminals.push(status);
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }
}

function pumpFactory(pumps: ImmediatePump[]) {
  return (destination: ProgressPumpDestination): ProgressPump => {
    const pump = new ImmediatePump(destination);
    pumps.push(pump);
    return pump;
  };
}

function controller(
  discord: DiscordProgressTransport,
  options: {
    createPump?: (destination: ProgressPumpDestination) => ProgressPump;
    heartbeatIntervalMs?: number;
    journal?: ProgressObservationJournalPort;
    now?: () => Date;
    onError?: (error: unknown) => void;
    reconciliationLimit?: number;
    sleep?: (milliseconds: number) => Promise<void>;
    terminalGraceMs?: number;
    timers?: {
      clearInterval(handle: unknown): void;
      setInterval(callback: () => void, milliseconds: number): unknown;
    };
  } = {},
) {
  return new DiscordProgressController({
    botUserId: BOT,
    ...(options.createPump === undefined ? {} : { createPump: options.createPump }),
    ...(options.heartbeatIntervalMs === undefined
      ? {}
      : { heartbeatIntervalMs: options.heartbeatIntervalMs }),
    journal: options.journal ?? journalPort(journal),
    now: options.now ?? (() => new Date(NOW)),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
    ...(options.reconciliationLimit === undefined
      ? {}
      : { reconciliationLimit: options.reconciliationLimit }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    ...(options.terminalGraceMs === undefined ? {} : { terminalGraceMs: options.terminalGraceMs }),
    ...(options.timers === undefined ? {} : { timers: options.timers }),
    transport: discord,
  });
}

async function seedThreadRecord(
  source: TurnProgressSource,
  state: "preparing" | "queued" | "running" | "completed" = "preparing",
  value = journal,
): Promise<ProgressObservationRecord> {
  const durableSource = turnSource(source);
  await value.beginCreation({
    createdAt: NOW,
    source: durableSource,
    threadCreationExpected: true,
  });
  await value.confirmDestination(
    source.messageId,
    {
      kind: "thread",
      ownerId: BOT,
      parentChannelId: source.channelId,
      threadId: source.messageId,
    },
    NOW,
  );
  await value.markPreparing(source.messageId, NOW);
  if (state === "queued" || state === "running" || state === "completed") {
    await value.markQueued(source.messageId, NOW);
  }
  if (state === "running" || state === "completed") {
    await value.markRunning(source.messageId, TURN, NOW);
  }
  if (state === "completed") {
    await value.close(source.messageId, "completed", LATER);
  }
  return (await value.get(source.messageId)) as ProgressObservationRecord;
}

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "codex-progress-controller-"));
  journal = new AtomicProgressObservationJournal({
    filePath: join(temporaryDirectory, "progress.json"),
  });
});

afterEach(async () => {
  await rm(temporaryDirectory, { force: true, recursive: true });
});

describe("DiscordProgressController destination creation", () => {
  it("persists intent before creating one message-started thread and reuses it on redelivery", async () => {
    const discord = transport();
    const pumps: ImmediatePump[] = [];
    discord.inspectProgressCapabilities.mockImplementation(async () => {
      expect(await journal.get(MESSAGE)).toMatchObject({
        expectedThreadId: MESSAGE,
        state: "creating",
      });
      return {
        createPublicThreads: true,
        manageThreads: true,
        sendMessagesInThreads: true,
      };
    });
    const progress = controller(discord, { createPump: pumpFactory(pumps) });

    await expect(progress.begin(guildSource())).resolves.toMatchObject({
      durable: true,
      kind: "thread",
      reused: false,
    });
    await expect(progress.begin(guildSource())).resolves.toMatchObject({
      durable: true,
      kind: "thread",
      reused: true,
    });

    expect(discord.inspectProgressCapabilities).toHaveBeenCalledOnce();
    expect(discord.createProgressThread).toHaveBeenCalledExactlyOnceWith(
      CHANNEL,
      MESSAGE,
      expect.objectContaining({ autoArchiveDuration: 1_440 }),
    );
    expect(await journal.get(MESSAGE)).toMatchObject({
      destination: {
        kind: "thread",
        ownerId: BOT,
        parentChannelId: CHANNEL,
        threadId: MESSAGE,
      },
    });
    expect(pumps).toHaveLength(1);
  });

  it("serializes concurrent Discord redelivery into one thread creation", async () => {
    const discord = transport();
    let releaseCapabilities!: () => void;
    const capabilityBarrier = new Promise<void>((resolve) => {
      releaseCapabilities = resolve;
    });
    discord.inspectProgressCapabilities.mockImplementation(async () => {
      await capabilityBarrier;
      return {
        createPublicThreads: true,
        manageThreads: true,
        sendMessagesInThreads: true,
      };
    });
    const progress = controller(discord, {
      createPump: pumpFactory([]),
      sleep: async () => undefined,
      terminalGraceMs: 1,
    });

    const first = progress.begin(guildSource());
    await vi.waitFor(() => expect(discord.inspectProgressCapabilities).toHaveBeenCalledOnce());
    const redelivery = progress.begin(guildSource());
    releaseCapabilities();

    await expect(first).resolves.toMatchObject({ reused: false });
    await expect(redelivery).resolves.toMatchObject({ reused: true });
    expect(discord.inspectProgressCapabilities).toHaveBeenCalledOnce();
    expect(discord.createProgressThread).toHaveBeenCalledOnce();
  });

  it.each([
    ["DM", dmSource()],
    ["user-owned thread", userThreadSource()],
  ])("uses one in-place status for a %s", async (_label, source) => {
    const discord = transport();
    const pumps: ImmediatePump[] = [];
    const progress = controller(discord, { createPump: pumpFactory(pumps) });

    await expect(progress.begin(source)).resolves.toMatchObject({
      durable: true,
      kind: "inPlace",
    });

    expect(discord.inspectProgressCapabilities).not.toHaveBeenCalled();
    expect(discord.createProgressThread).not.toHaveBeenCalled();
    expect(discord.sendMessage).toHaveBeenCalledOnce();
    expect(await journal.get(source.messageId)).toMatchObject({
      destination: {
        channelId: source.channelId,
        kind: "inPlace",
        messageId: STATUS_MESSAGE,
      },
    });
  });

  it.each(["createPublicThreads", "sendMessagesInThreads", "manageThreads"] as const)(
    "falls back in place when %s is missing",
    async (missing) => {
      const discord = transport();
      discord.inspectProgressCapabilities.mockResolvedValue({
        createPublicThreads: missing !== "createPublicThreads",
        manageThreads: missing !== "manageThreads",
        sendMessagesInThreads: missing !== "sendMessagesInThreads",
      });
      const progress = controller(discord, { createPump: pumpFactory([]) });

      await expect(progress.begin(guildSource())).resolves.toMatchObject({
        kind: "inPlace",
      });
      expect(discord.createProgressThread).not.toHaveBeenCalled();
      expect(discord.sendMessage).toHaveBeenCalledOnce();
    },
  );

  it("uses in-place fallback on capability errors and journal capacity without creating a thread", async () => {
    const permissionDiscord = transport();
    permissionDiscord.inspectProgressCapabilities.mockRejectedValue(
      new BridgeError("UNAUTHORIZED", "denied"),
    );
    await controller(permissionDiscord, { createPump: pumpFactory([]) }).begin(guildSource());
    expect(permissionDiscord.createProgressThread).not.toHaveBeenCalled();
    expect(permissionDiscord.sendMessage).toHaveBeenCalledOnce();

    const limited = new AtomicProgressObservationJournal({
      filePath: join(temporaryDirectory, "limited.json"),
      maxActiveRecords: 1,
      maxTotalRecords: 2,
    });
    await seedThreadRecord(guildSource(SECOND_MESSAGE), "preparing", limited);
    const capacityDiscord = transport();
    await controller(capacityDiscord, {
      createPump: pumpFactory([]),
      journal: journalPort(limited),
    }).begin(guildSource(THIRD_MESSAGE));
    expect(capacityDiscord.inspectProgressCapabilities).not.toHaveBeenCalled();
    expect(capacityDiscord.createProgressThread).not.toHaveBeenCalled();
    expect(capacityDiscord.sendMessage).toHaveBeenCalledOnce();
  });

  it("never calls thread APIs after journal failure and returns a non-durable fallback", async () => {
    const discord = transport();
    const failingJournal = journalPort(journal, {
      beginCreation: vi.fn(async () => {
        throw new BridgeError("RUNTIME", "storage failed");
      }),
    });
    const progress = controller(discord, {
      createPump: pumpFactory([]),
      journal: failingJournal,
    });

    await expect(progress.begin(guildSource())).resolves.toEqual({
      durable: false,
      kind: "inPlace",
      reused: false,
    });
    expect(discord.inspectProgressCapabilities).not.toHaveBeenCalled();
    expect(discord.createProgressThread).not.toHaveBeenCalled();
    expect(discord.sendMessage).toHaveBeenCalledOnce();
  });

  it.each(["journal-and-in-place", "thread-and-in-place"] as const)(
    "returns a no-op after %s failure and attempts one bounded parent diagnostic",
    async (mode) => {
      const discord = transport();
      const beginCreation =
        mode === "journal-and-in-place"
          ? vi.fn(async () => {
              throw new BridgeError("RUNTIME", "journal failed");
            })
          : journal.beginCreation.bind(journal);
      if (mode === "thread-and-in-place") {
        discord.createProgressThread.mockRejectedValue(new BridgeError("RUNTIME", "thread failed"));
      }
      discord.sendMessage
        .mockRejectedValueOnce(new BridgeError("RUNTIME", "status failed"))
        .mockResolvedValueOnce({ id: STATUS_MESSAGE });
      const progress = controller(discord, {
        createPump: pumpFactory([]),
        journal: journalPort(journal, { beginCreation }),
      });

      await expect(progress.begin(guildSource())).resolves.toMatchObject({
        durable: false,
        kind: "none",
      });
      expect(discord.sendMessage).toHaveBeenCalledTimes(2);
      expect(discord.sendMessage.mock.calls[1]?.[1]).toEqual({
        content: "Progress display is unavailable; the Codex turn will continue.",
      });
    },
  );

  it("never includes caller-owned prompt metadata in thread operations", async () => {
    const discord = transport();
    const secret = "private prompt and attachment name";
    const progress = controller(discord, { createPump: pumpFactory([]) });

    await progress.begin({ ...guildSource(), prompt: secret } as DiscordProgressControllerSource);

    expect(JSON.stringify(discord.createProgressThread.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(discord.sendMessage.mock.calls)).not.toContain(secret);
  });

  it("closes a confirmed thread intent after its status send falls back in place", async () => {
    const discord = transport();
    discord.sendMessage
      .mockRejectedValueOnce(new BridgeError("RUNTIME", "thread status failed"))
      .mockResolvedValueOnce({ id: STATUS_MESSAGE });
    const progress = controller(discord, {
      createPump: pumpFactory([]),
      sleep: async () => undefined,
      terminalGraceMs: 1,
    });

    await expect(progress.begin(guildSource())).resolves.toMatchObject({
      durable: false,
      kind: "inPlace",
    });
    await progress.terminal(guildSource(), { status: "failed", type: "terminal" });

    expect(await journal.get(MESSAGE)).toMatchObject({
      destination: { kind: "thread", threadId: MESSAGE },
      state: "failed",
    });
  });
});

describe("DiscordProgressController provenance and lifecycle", () => {
  it("requires durable provenance and verified bot ownership for progress-only ingress", async () => {
    const discord = transport();
    const progress = controller(discord, { createPump: pumpFactory([]) });
    await progress.begin(guildSource());

    await expect(progress.isProgressOnlyThread(progressThreadEvent())).resolves.toBe(true);
    await expect(progress.isProgressOnlyThread(progressThreadEvent(SECOND_MESSAGE))).resolves.toBe(
      false,
    );

    discord.inspectThread.mockResolvedValueOnce({
      archived: false,
      id: MESSAGE,
      locked: false,
      ownerId: OWNER,
      parentId: CHANNEL,
      status: "found",
    });
    await expect(progress.isProgressOnlyThread(progressThreadEvent())).rejects.toMatchObject({
      code: "CONFIGURATION",
    });
  });

  it("reports startup terminal states, converts sending to uncertain, and retains tombstones", async () => {
    await seedThreadRecord(guildSource(MESSAGE), "preparing");
    await seedThreadRecord(guildSource(SECOND_MESSAGE), "queued");
    await seedThreadRecord(guildSource(THIRD_MESSAGE), "running");
    const reservation = await journal.beginDelivery(THIRD_MESSAGE, NOW);
    const discord = transport();
    const order: string[] = [];
    discord.sendMessage.mockImplementation(async (channelId: string) => {
      order.push(`report:${channelId}`);
      return { id: STATUS_MESSAGE };
    });
    discord.setProgressThreadState.mockImplementation(async (threadId: string) => {
      order.push(`close:${threadId}`);
    });
    const progress = controller(discord, { createPump: pumpFactory([]) });

    await progress.initializeAfterLogin();

    expect(await journal.get(MESSAGE)).toMatchObject({ state: "failed" });
    expect(await journal.get(SECOND_MESSAGE)).toMatchObject({ state: "failed" });
    expect(await journal.get(THIRD_MESSAGE)).toMatchObject({
      delivery: {
        current: { sequence: reservation.sequence, status: "uncertain" },
      },
      state: "interrupted",
    });
    expect(discord.sendMessage.mock.calls).toEqual([
      [
        MESSAGE,
        {
          content: "Failed: Runner restarted before this turn started. The turn was not resumed.",
        },
      ],
      [
        SECOND_MESSAGE,
        {
          content: "Failed: Runner restarted before this turn started. The turn was not resumed.",
        },
      ],
      [
        THIRD_MESSAGE,
        {
          content:
            "Interrupted: Runner restarted before final delivery was confirmed. Final delivery may be partial or uncertain. Check the parent conversation; no output was replayed.",
        },
      ],
    ]);
    expect(order).toEqual([
      `report:${MESSAGE}`,
      `close:${MESSAGE}`,
      `report:${SECOND_MESSAGE}`,
      `close:${SECOND_MESSAGE}`,
      `report:${THIRD_MESSAGE}`,
      `close:${THIRD_MESSAGE}`,
    ]);
    expect(discord.setProgressThreadState).toHaveBeenCalledTimes(3);
    const reopened = new AtomicProgressObservationJournal({
      filePath: join(temporaryDirectory, "progress.json"),
    });
    expect((await reopened.listTerminalTombstones({ limit: 10 })).records).toHaveLength(3);
  });

  it("verifies and closes a thread created before destination confirmation", async () => {
    await journal.beginCreation({
      createdAt: NOW,
      source: turnSource(guildSource()),
      threadCreationExpected: true,
    });
    const discord = transport();

    await controller(discord, { createPump: pumpFactory([]) }).initializeAfterLogin();

    expect(discord.createProgressThread).not.toHaveBeenCalled();
    expect(discord.sendMessage).toHaveBeenCalledExactlyOnceWith(MESSAGE, {
      content: "Failed: Runner restarted before this turn started. The turn was not resumed.",
    });
    expect(discord.setProgressThreadState).toHaveBeenCalledExactlyOnceWith(MESSAGE, {
      archived: true,
      locked: true,
    });
    expect(await journal.get(MESSAGE)).toMatchObject({
      destination: {
        kind: "thread",
        ownerId: BOT,
        parentChannelId: CHANNEL,
        threadId: MESSAGE,
      },
      state: "failed",
    });
  });

  it("replaces an abandoned in-place status with a fixed restart terminal state", async () => {
    await journal.beginCreation({
      createdAt: NOW,
      source: turnSource(dmSource()),
      threadCreationExpected: false,
    });
    await journal.confirmDestination(
      MESSAGE,
      {
        channelId: CHANNEL,
        kind: "inPlace",
        messageId: STATUS_MESSAGE,
      },
      NOW,
    );
    await journal.markPreparing(MESSAGE, NOW);
    const discord = transport();

    await controller(discord, { createPump: pumpFactory([]) }).initializeAfterLogin();

    expect(discord.editMessage).toHaveBeenCalledExactlyOnceWith(CHANNEL, STATUS_MESSAGE, {
      content: "Failed: Runner restarted before this turn started. The turn was not resumed.",
    });
    expect(discord.sendMessage).not.toHaveBeenCalled();
    expect(discord.setProgressThreadState).not.toHaveBeenCalled();
    expect(await journal.get(MESSAGE)).toBeUndefined();
  });

  it("keeps startup recovery best-effort when the terminal notice cannot be delivered", async () => {
    await seedThreadRecord(guildSource(), "running");
    const discord = transport();
    const onError = vi.fn();
    discord.sendMessage.mockRejectedValueOnce(new BridgeError("RUNTIME", "send failed"));

    await expect(
      controller(discord, { createPump: pumpFactory([]), onError }).initializeAfterLogin(),
    ).resolves.toBeUndefined();

    expect(await journal.get(MESSAGE)).toMatchObject({ state: "interrupted" });
    expect(discord.setProgressThreadState).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();
  });

  it("flushes terminal status before grace, verification, and bot-owned thread closure", async () => {
    const discord = transport();
    const pumps: ImmediatePump[] = [];
    const order: string[] = [];
    const progress = controller(discord, {
      createPump: (destination) => {
        const pump = new ImmediatePump(destination);
        const terminal = pump.terminal.bind(pump);
        pump.terminal = async (status) => {
          order.push("terminal");
          await terminal(status);
        };
        pumps.push(pump);
        return pump;
      },
      sleep: async () => {
        expect(await journal.get(MESSAGE)).toMatchObject({ state: "completed" });
        order.push("grace");
      },
      terminalGraceMs: 5,
    });
    discord.inspectThread.mockImplementation(async () => {
      order.push("inspect");
      return {
        archived: false,
        id: MESSAGE,
        locked: false,
        ownerId: BOT,
        parentId: CHANNEL,
        status: "found",
      };
    });
    discord.setProgressThreadState.mockImplementation(async () => {
      order.push("close-thread");
    });
    await progress.begin(guildSource());
    await progress.preparing(guildSource());
    await progress.queued(guildSource());
    await progress.bindTurn(guildSource(), TURN);

    await progress.terminal(guildSource(), {
      status: "completed",
      type: "terminal",
    });

    expect(order).toEqual(["terminal", "grace", "inspect", "close-thread"]);
    expect(discord.setProgressThreadState).toHaveBeenCalledWith(MESSAGE, {
      archived: true,
      locked: true,
    });
    expect(pumps[0]?.terminals[0]).toEqual({ text: "Completed", type: "terminal" });

    const threadCreations = discord.createProgressThread.mock.calls.length;
    const statusMessages = discord.sendMessage.mock.calls.length;
    await expect(progress.begin(guildSource())).resolves.toMatchObject({
      reused: true,
    });
    expect(discord.createProgressThread).toHaveBeenCalledTimes(threadCreations);
    expect(discord.sendMessage).toHaveBeenCalledTimes(statusMessages);
  });

  it("leaves a mismatched thread untouched and reports a bounded configuration failure", async () => {
    const discord = transport();
    const onError = vi.fn();
    const progress = controller(discord, {
      createPump: pumpFactory([]),
      onError,
      sleep: async () => undefined,
      terminalGraceMs: 1,
    });
    await progress.begin(guildSource());
    await progress.preparing(guildSource());
    discord.inspectThread.mockResolvedValue({
      archived: false,
      id: MESSAGE,
      locked: false,
      ownerId: OWNER,
      parentId: CHANNEL,
      status: "found",
    });

    await progress.terminal(guildSource(), { status: "failed", type: "terminal" });

    expect(discord.setProgressThreadState).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "CONFIGURATION" }));
    expect(await journal.get(MESSAGE)).toMatchObject({ state: "failed" });
  });

  it("does not archive a thread when its terminal journal close fails", async () => {
    const discord = transport();
    const onError = vi.fn();
    const close = vi.fn(async () => {
      throw new BridgeError("RUNTIME", "journal close failed");
    });
    const progress = controller(discord, {
      createPump: pumpFactory([]),
      journal: journalPort(journal, { close }),
      onError,
      sleep: async () => undefined,
      terminalGraceMs: 1,
    });
    await progress.begin(guildSource());
    await progress.preparing(guildSource());

    await progress.terminal(guildSource(), { status: "failed", type: "terminal" });

    expect(close).toHaveBeenCalledOnce();
    expect(discord.inspectThread).not.toHaveBeenCalled();
    expect(discord.setProgressThreadState).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
  });

  it("processes requested tombstones first and removes only authoritative not-found records", async () => {
    await seedThreadRecord(guildSource(MESSAGE), "completed");
    await seedThreadRecord(guildSource(SECOND_MESSAGE), "completed");
    await seedThreadRecord(guildSource(THIRD_MESSAGE), "completed");
    await seedThreadRecord(guildSource(FOURTH_MESSAGE), "completed");
    await journal.requestTombstoneReconciliation(FOURTH_MESSAGE, LATER);
    const discord = transport();
    const inspected: string[] = [];
    discord.inspectThread.mockImplementation(async (threadId: string) => {
      inspected.push(threadId);
      if (threadId === MESSAGE) return { status: "not-found", threadId };
      if (threadId === FOURTH_MESSAGE) throw new BridgeError("UNAUTHORIZED", "denied");
      return {
        archived: true,
        id: threadId,
        locked: true,
        ownerId: threadId === SECOND_MESSAGE ? OWNER : BOT,
        parentId: CHANNEL,
        status: "found",
      };
    });
    const progress = controller(discord, {
      createPump: pumpFactory([]),
      reconciliationLimit: 2,
    });

    await progress.reconcileTerminalTombstones();

    expect(inspected).toEqual([FOURTH_MESSAGE, MESSAGE, SECOND_MESSAGE]);
    expect(await journal.get(MESSAGE)).toBeUndefined();
    expect(await journal.get(SECOND_MESSAGE)).toBeDefined();
    expect(await journal.get(THIRD_MESSAGE)).toBeDefined();
    expect(await journal.get(FOURTH_MESSAGE)).toBeDefined();
  });

  it("restores journal capacity only after requested deletion is authoritatively verified", async () => {
    const limited = new AtomicProgressObservationJournal({
      filePath: join(temporaryDirectory, "capacity.json"),
      maxActiveRecords: 1,
      maxTotalRecords: 1,
    });
    await seedThreadRecord(guildSource(MESSAGE), "completed", limited);
    await limited.requestTombstoneReconciliation(MESSAGE, LATER);
    await expect(
      limited.beginCreation({
        createdAt: LATER,
        source: turnSource(guildSource(SECOND_MESSAGE)),
        threadCreationExpected: true,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const discord = transport();
    discord.inspectThread.mockResolvedValue({ status: "not-found", threadId: MESSAGE });
    const progress = controller(discord, {
      createPump: pumpFactory([]),
      journal: journalPort(limited),
    });

    await progress.reconcileTerminalTombstones();

    await expect(
      limited.beginCreation({
        createdAt: LATER,
        source: turnSource(guildSource(SECOND_MESSAGE)),
        threadCreationExpected: true,
      }),
    ).resolves.toBeDefined();
  });
});

describe("DiscordProgressController final delivery", () => {
  it("decorates nonempty final text with one canonical progress-thread link", async () => {
    const discord = transport();
    const progress = controller(discord, { createPump: pumpFactory([]) });
    await progress.begin(guildSource());

    expect(progress.decorateFinalText(guildSource(), "Final answer.")).toBe(
      `Progress: https://discord.com/channels/${GUILD}/${MESSAGE}\n\nFinal answer.`,
    );
    expect(progress.decorateFinalText(guildSource(), "")).toBe("");
  });

  it("serializes sends, forces only the first source reply, and persists accepted receipts", async () => {
    const discord = transport();
    const progress = controller(discord, { createPump: pumpFactory([]) });
    await progress.begin(guildSource());
    await progress.preparing(guildSource());
    await progress.queued(guildSource());
    await progress.bindTurn(guildSource(), TURN);
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const directives: Array<{ replyToMessageId?: string }> = [];
    let calls = 0;
    const operation = vi.fn(async (directive: { replyToMessageId?: string }) => {
      directives.push(directive);
      calls += 1;
      if (calls === 1) await firstBlocked;
      return {
        channelId: CHANNEL,
        messageId: String(BigInt(RESPONSE_MESSAGE) + BigInt(calls - 1)),
      } satisfies DiscordDeliveryReceipt;
    });

    const first = progress.deliver(guildSource(), operation);
    const second = progress.deliver(guildSource(), operation);
    await vi.waitFor(() => expect(operation).toHaveBeenCalledOnce());
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);

    expect(directives).toEqual([{ replyToMessageId: MESSAGE }, {}]);
    expect(await journal.get(MESSAGE)).toMatchObject({
      delivery: {
        acceptedThrough: 2,
        firstAcceptedReceipt: {
          channelId: CHANNEL,
          messageId: RESPONSE_MESSAGE,
        },
        nextSequence: 3,
      },
    });
  });

  it("waits for receipt persistence before terminal output and links the first accepted reply", async () => {
    const discord = transport();
    const pumps: ImmediatePump[] = [];
    const acceptGate = deferred<void>();
    const acceptDelivery = vi.fn(
      async (
        sourceMessageId: string,
        sequence: number,
        receipt: DiscordDeliveryReceipt,
        updatedAt: string,
      ) => {
        await acceptGate.promise;
        await journal.acceptDelivery(sourceMessageId, sequence, receipt, updatedAt);
      },
    );
    const progress = controller(discord, {
      createPump: pumpFactory(pumps),
      journal: journalPort(journal, { acceptDelivery }),
      terminalGraceMs: 1,
    });
    await progress.begin(guildSource());
    await progress.preparing(guildSource());
    await progress.queued(guildSource());
    await progress.bindTurn(guildSource(), TURN);

    const delivery = progress.deliver(guildSource(), async () => ({
      channelId: CHANNEL,
      messageId: RESPONSE_MESSAGE,
    }));
    await vi.waitFor(() => expect(acceptDelivery).toHaveBeenCalledOnce());
    const terminal = progress.terminal(guildSource(), {
      status: "completed",
      type: "terminal",
    });
    await Promise.resolve();

    expect(pumps[0]?.terminals).toHaveLength(0);
    expect(discord.setProgressThreadState).not.toHaveBeenCalled();
    acceptGate.resolve();
    await expect(delivery).resolves.toEqual({
      channelId: CHANNEL,
      messageId: RESPONSE_MESSAGE,
    });
    await terminal;

    expect(pumps[0]?.terminals[0]?.text).toContain(
      `https://discord.com/channels/${GUILD}/${CHANNEL}/${RESPONSE_MESSAGE}`,
    );
    expect(discord.setProgressThreadState).toHaveBeenCalledOnce();
  });

  it("heartbeats from the last verified event and cancels the timer at terminal", async () => {
    const discord = transport();
    const pumps: ImmediatePump[] = [];
    const callbacks = new Set<() => void>();
    const clearInterval = vi.fn((handle: unknown) => {
      callbacks.delete(handle as () => void);
    });
    const setInterval = vi.fn((callback: () => void) => {
      callbacks.add(callback);
      return callback;
    });
    let now = Date.parse(NOW);
    const progress = controller(discord, {
      createPump: pumpFactory(pumps),
      heartbeatIntervalMs: 30_000,
      now: () => new Date(now),
      sleep: async () => undefined,
      terminalGraceMs: 1,
      timers: { clearInterval, setInterval },
    });
    await progress.begin(guildSource());
    await progress.preparing(guildSource());
    await progress.queued(guildSource());
    await progress.bindTurn(guildSource(), TURN);
    now += 10_000;
    await progress.event(guildSource(), { message: "warning", type: "warning" });
    now += 30_000;

    expect(setInterval).toHaveBeenCalledExactlyOnceWith(expect.any(Function), 30_000);
    const callback = [...callbacks][0];
    if (callback === undefined) throw new Error("heartbeat callback was not installed");
    callback();
    await vi.waitFor(() => expect(pumps[0]?.heartbeats).toEqual([Date.parse(NOW) + 10_000]));

    await progress.terminal(guildSource(), { status: "completed", type: "terminal" });
    expect(clearInterval).toHaveBeenCalledExactlyOnceWith(callback);
    callback();
    await Promise.resolve();
    expect(pumps[0]?.heartbeats).toHaveLength(1);
  });

  it("marks rejected sends failed and unpersisted receipts uncertain", async () => {
    const failedProgress = controller(transport(), { createPump: pumpFactory([]) });
    await failedProgress.begin(guildSource());
    await failedProgress.preparing(guildSource());
    await failedProgress.queued(guildSource());
    await failedProgress.bindTurn(guildSource(), TURN);

    await expect(
      failedProgress.deliver(guildSource(), async () => {
        throw new Error("Discord rejected");
      }),
    ).rejects.toThrow("Discord rejected");
    expect(await journal.get(MESSAGE)).toMatchObject({
      delivery: { current: { sequence: 1, status: "failed" } },
    });

    const uncertainSource = guildSource(SECOND_MESSAGE);
    const uncertainProgress = controller(transport(), {
      createPump: pumpFactory([]),
      journal: journalPort(journal, {
        acceptDelivery: vi.fn(async () => {
          throw new Error("receipt write failed");
        }),
      }),
    });
    await uncertainProgress.begin(uncertainSource);
    await uncertainProgress.preparing(uncertainSource);
    await uncertainProgress.queued(uncertainSource);
    await uncertainProgress.bindTurn(uncertainSource, TURN);
    await expect(
      uncertainProgress.deliver(uncertainSource, async () => ({
        channelId: CHANNEL,
        messageId: RESPONSE_MESSAGE,
      })),
    ).rejects.toMatchObject({ code: "RUNTIME" });
    expect(await journal.get(SECOND_MESSAGE)).toMatchObject({
      delivery: { current: { sequence: 1, status: "uncertain" } },
    });
  });

  it("does not invoke a final send when durable reservation fails", async () => {
    const discord = transport();
    const beginDelivery = vi.fn(async () => {
      throw new BridgeError("RUNTIME", "journal unavailable");
    });
    const progress = controller(discord, {
      createPump: pumpFactory([]),
      journal: journalPort(journal, { beginDelivery }),
    });
    await progress.begin(guildSource());
    await progress.preparing(guildSource());
    await progress.queued(guildSource());
    await progress.bindTurn(guildSource(), TURN);
    const operation = vi.fn(async () => ({
      channelId: CHANNEL,
      messageId: RESPONSE_MESSAGE,
    }));

    await expect(progress.deliver(guildSource(), operation)).rejects.toMatchObject({
      code: "RUNTIME",
    });
    expect(operation).not.toHaveBeenCalled();
  });
});
