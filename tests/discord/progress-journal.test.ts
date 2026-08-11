import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AtomicProgressObservationJournal,
  type ProgressObservationRecord,
} from "../../src/discord/progress-journal.js";

const SOURCE_CHANNEL = "300000000000000001";
const SOURCE_ONE = "300000000000000002";
const SOURCE_TWO = "300000000000000003";
const SOURCE_THREE = "300000000000000004";
const BOT_USER = "200000000000000001";
const STATUS_MESSAGE = "400000000000000001";
const TURN_ONE = "00000000-0000-4000-8000-000000000001";
const CREATED_AT = "2026-07-31T00:00:00.000Z";
const PREPARING_AT = "2026-07-31T00:00:01.000Z";
const QUEUED_AT = "2026-07-31T00:00:02.000Z";
const RUNNING_AT = "2026-07-31T00:00:03.000Z";
const DELIVERY_AT = "2026-07-31T00:00:04.000Z";
const COMPLETED_AT = "2026-07-31T00:00:05.000Z";

const temporaryDirectories: string[] = [];

async function journalPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codex-progress-journal-"));
  temporaryDirectories.push(directory);
  return join(directory, "state", "progress-observations.json");
}

function source(messageId = SOURCE_ONE) {
  return {
    channelId: SOURCE_CHANNEL,
    guildId: "100000000000000001",
    messageId,
  };
}

function threadDestination(threadId = SOURCE_ONE) {
  return {
    kind: "thread" as const,
    ownerId: BOT_USER,
    parentChannelId: SOURCE_CHANNEL,
    threadId,
  };
}

async function runningObservation(
  journal: AtomicProgressObservationJournal,
  messageId = SOURCE_ONE,
): Promise<void> {
  await journal.beginCreation({
    createdAt: CREATED_AT,
    source: source(messageId),
    threadCreationExpected: true,
  });
  await journal.confirmDestination(messageId, threadDestination(messageId), PREPARING_AT);
  await journal.markPreparing(messageId, PREPARING_AT);
  await journal.markQueued(messageId, QUEUED_AT);
  await journal.markRunning(messageId, TURN_ONE, RUNNING_AT);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("AtomicProgressObservationJournal", () => {
  it("persists creation intent before destination confirmation and freezes reads", async () => {
    const filePath = await journalPath();
    const journal = new AtomicProgressObservationJournal({ filePath });

    const created = await journal.beginCreation({
      createdAt: CREATED_AT,
      source: source(),
      threadCreationExpected: true,
    });

    expect(created).toMatchObject({
      createdAt: CREATED_AT,
      delivery: { acceptedThrough: 0, nextSequence: 1 },
      expectedThreadId: SOURCE_ONE,
      source: source(),
      state: "creating",
      updatedAt: CREATED_AT,
    });
    expect(created.destination).toBeUndefined();
    expect(Object.isFrozen(created)).toBe(true);
    expect(Object.isFrozen(created.source)).toBe(true);

    const reloaded = new AtomicProgressObservationJournal({ filePath });
    await expect(reloaded.get(SOURCE_ONE)).resolves.toEqual(created);
  });

  it("is idempotent for the same source and rejects mismatched reuse or duplicate threads", async () => {
    const journal = new AtomicProgressObservationJournal({ filePath: await journalPath() });
    const input = {
      createdAt: CREATED_AT,
      source: source(),
      threadCreationExpected: true,
    };
    const first = await journal.beginCreation(input);
    await expect(journal.beginCreation(input)).resolves.toEqual(first);
    await expect(
      journal.beginCreation({
        ...input,
        threadCreationExpected: false,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    await journal.confirmDestination(SOURCE_ONE, threadDestination(), PREPARING_AT);
    await journal.beginCreation({
      createdAt: CREATED_AT,
      source: source(SOURCE_TWO),
      threadCreationExpected: true,
    });
    await expect(
      journal.confirmDestination(SOURCE_TWO, threadDestination(SOURCE_ONE), PREPARING_AT),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("enforces legal lifecycle transitions and retains terminal thread provenance", async () => {
    const journal = new AtomicProgressObservationJournal({ filePath: await journalPath() });
    await runningObservation(journal);

    await expect(journal.markQueued(SOURCE_ONE, RUNNING_AT)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await journal.close(SOURCE_ONE, "completed", COMPLETED_AT);

    await expect(journal.get(SOURCE_ONE)).resolves.toMatchObject({
      destination: threadDestination(),
      state: "completed",
      turnId: TURN_ONE,
      updatedAt: COMPLETED_AT,
    });
    await expect(journal.listActive()).resolves.toEqual([]);
    await expect(journal.isProgressThread(SOURCE_ONE)).resolves.toBe(true);
  });

  it("advances delivery sequences and preserves the immutable first receipt", async () => {
    const journal = new AtomicProgressObservationJournal({ filePath: await journalPath() });
    await runningObservation(journal);

    await expect(journal.beginDelivery(SOURCE_ONE, DELIVERY_AT)).resolves.toEqual({
      first: true,
      sequence: 1,
    });
    await expect(journal.beginDelivery(SOURCE_ONE, DELIVERY_AT)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await journal.acceptDelivery(
      SOURCE_ONE,
      1,
      { channelId: SOURCE_CHANNEL, messageId: STATUS_MESSAGE },
      DELIVERY_AT,
    );

    await expect(journal.beginDelivery(SOURCE_ONE, DELIVERY_AT)).resolves.toEqual({
      first: false,
      sequence: 2,
    });
    await journal.acceptDelivery(
      SOURCE_ONE,
      2,
      { channelId: SOURCE_CHANNEL, messageId: "400000000000000002" },
      DELIVERY_AT,
    );

    await expect(journal.get(SOURCE_ONE)).resolves.toMatchObject({
      delivery: {
        acceptedThrough: 2,
        firstAcceptedReceipt: {
          channelId: SOURCE_CHANNEL,
          messageId: STATUS_MESSAGE,
        },
        nextSequence: 3,
      },
    });
  });

  it("serializes concurrent delivery starts without duplicate first claims", async () => {
    const journal = new AtomicProgressObservationJournal({ filePath: await journalPath() });
    await runningObservation(journal);

    const results = await Promise.allSettled([
      journal.beginDelivery(SOURCE_ONE, DELIVERY_AT),
      journal.beginDelivery(SOURCE_ONE, DELIVERY_AT),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(results.find((result) => result.status === "fulfilled")).toMatchObject({
      value: { first: true, sequence: 1 },
    });
  });

  it("converts only an in-flight send to uncertain on startup", async () => {
    const filePath = await journalPath();
    const journal = new AtomicProgressObservationJournal({ filePath });
    await runningObservation(journal);
    await journal.beginDelivery(SOURCE_ONE, DELIVERY_AT);
    await journal.acceptDelivery(
      SOURCE_ONE,
      1,
      { channelId: SOURCE_CHANNEL, messageId: STATUS_MESSAGE },
      DELIVERY_AT,
    );
    await journal.beginDelivery(SOURCE_ONE, DELIVERY_AT);

    const reloaded = new AtomicProgressObservationJournal({ filePath });
    await reloaded.initialize(COMPLETED_AT);

    await expect(reloaded.get(SOURCE_ONE)).resolves.toMatchObject({
      delivery: {
        acceptedThrough: 1,
        current: { sequence: 2, status: "uncertain" },
        firstAcceptedReceipt: {
          channelId: SOURCE_CHANNEL,
          messageId: STATUS_MESSAGE,
        },
        nextSequence: 3,
      },
    });
  });

  it("paginates and explicitly reconciles terminal tombstones to recover capacity", async () => {
    const journal = new AtomicProgressObservationJournal({
      filePath: await journalPath(),
      maxActiveRecords: 2,
      maxTotalRecords: 2,
    });
    for (const messageId of [SOURCE_ONE, SOURCE_TWO]) {
      await runningObservation(journal, messageId);
      await journal.close(messageId, "completed", COMPLETED_AT);
    }

    await expect(
      journal.beginCreation({
        createdAt: CREATED_AT,
        source: source(SOURCE_THREE),
        threadCreationExpected: true,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const firstPage = await journal.listTerminalTombstones({ limit: 1 });
    expect(firstPage.records).toHaveLength(1);
    expect(firstPage.nextCursor).toBeDefined();
    const secondPage = await journal.listTerminalTombstones({
      cursor: firstPage.nextCursor,
      limit: 1,
    });
    expect(secondPage.records).toHaveLength(1);

    await journal.requestTombstoneReconciliation(SOURCE_ONE, COMPLETED_AT);
    await expect(journal.listRequestedTombstoneReconciliations(10)).resolves.toMatchObject([
      { expectedThreadId: SOURCE_ONE },
    ]);
    await journal.removeDeletedThreadTombstone(SOURCE_ONE);
    await expect(journal.isProgressThread(SOURCE_ONE)).resolves.toBe(false);
    await expect(
      journal.beginCreation({
        createdAt: CREATED_AT,
        source: source(SOURCE_THREE),
        threadCreationExpected: true,
      }),
    ).resolves.toMatchObject({ state: "creating" });
  });

  it("does not retain completed in-place observations without possible thread provenance", async () => {
    const journal = new AtomicProgressObservationJournal({
      filePath: await journalPath(),
      maxActiveRecords: 1,
      maxTotalRecords: 1,
    });
    await journal.beginCreation({
      createdAt: CREATED_AT,
      source: { channelId: SOURCE_CHANNEL, messageId: SOURCE_ONE },
      threadCreationExpected: false,
    });
    await journal.confirmDestination(
      SOURCE_ONE,
      { channelId: SOURCE_CHANNEL, kind: "inPlace", messageId: STATUS_MESSAGE },
      PREPARING_AT,
    );
    await journal.markPreparing(SOURCE_ONE, PREPARING_AT);
    await journal.markQueued(SOURCE_ONE, QUEUED_AT);
    await journal.markRunning(SOURCE_ONE, TURN_ONE, RUNNING_AT);
    await journal.close(SOURCE_ONE, "completed", COMPLETED_AT);

    await expect(journal.get(SOURCE_ONE)).resolves.toBeUndefined();
    await expect(
      journal.beginCreation({
        createdAt: CREATED_AT,
        source: { channelId: SOURCE_CHANNEL, messageId: SOURCE_TWO },
        threadCreationExpected: false,
      }),
    ).resolves.toMatchObject({ state: "creating" });
  });

  it("rejects prompt-like unknown fields in input and persisted records", async () => {
    const filePath = await journalPath();
    const journal = new AtomicProgressObservationJournal({ filePath });
    await expect(
      journal.beginCreation({
        createdAt: CREATED_AT,
        prompt: "do not persist this",
        source: source(),
        threadCreationExpected: true,
      } as never),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

    await journal.beginCreation({
      createdAt: CREATED_AT,
      source: source(),
      threadCreationExpected: true,
    });
    const persisted = JSON.parse(await readFile(filePath, "utf8")) as {
      records: Record<string, ProgressObservationRecord & { prompt?: string }>;
    };
    const persistedRecord = persisted.records[SOURCE_ONE];
    expect(persistedRecord).toBeDefined();
    if (persistedRecord === undefined) {
      throw new Error("test fixture record missing");
    }
    persistedRecord.prompt = "secret prompt";
    await writeFile(filePath, JSON.stringify(persisted), "utf8");

    const reloaded = new AtomicProgressObservationJournal({ filePath });
    await expect(reloaded.get(SOURCE_ONE)).rejects.toMatchObject({ code: "CONFIGURATION" });
  });

  it("preserves committed data across atomic faults and concurrent writers", async () => {
    const filePath = await journalPath();
    await new AtomicProgressObservationJournal({ filePath }).initialize(CREATED_AT);
    let inject = true;
    const faulting = new AtomicProgressObservationJournal({
      faultInjector(point) {
        if (inject && point === "after-rename") {
          inject = false;
          throw new Error("injected");
        }
      },
      filePath,
      maxActiveRecords: 20,
      maxTotalRecords: 20,
    });
    await expect(
      faulting.beginCreation({
        createdAt: CREATED_AT,
        source: source(),
        threadCreationExpected: true,
      }),
    ).rejects.toMatchObject({ code: "RUNTIME" });
    await expect(
      new AtomicProgressObservationJournal({ filePath }).get(SOURCE_ONE),
    ).resolves.toMatchObject({ state: "creating" });

    const first = new AtomicProgressObservationJournal({
      filePath,
      maxActiveRecords: 20,
      maxTotalRecords: 20,
    });
    const second = new AtomicProgressObservationJournal({
      filePath,
      maxActiveRecords: 20,
      maxTotalRecords: 20,
    });
    await Promise.all(
      [SOURCE_TWO, SOURCE_THREE].map((messageId, index) =>
        (index === 0 ? first : second).beginCreation({
          createdAt: CREATED_AT,
          source: source(messageId),
          threadCreationExpected: true,
        }),
      ),
    );
    await expect(first.listActive()).resolves.toHaveLength(3);
  });
});
