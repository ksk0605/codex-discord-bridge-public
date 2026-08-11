import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AtomicThreadCreationJournal } from "../../src/app-server/thread-creation-journal.js";

const OPERATION_ONE = "11111111-1111-4111-8111-111111111111";
const OPERATION_TWO = "22222222-2222-4222-8222-222222222222";
const OPERATION_THREE = "33333333-3333-4333-8333-333333333333";
const THREAD_ONE = "019535d0-9f4a-7cc3-98c4-1d8efc0c1234";
const STARTED_AT = "2026-07-27T08:00:00.000Z";

const temporaryDirectories: string[] = [];

async function journalPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codex-thread-journal-"));
  temporaryDirectories.push(directory);
  return join(directory, "state", "thread-creations.json");
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("AtomicThreadCreationJournal", () => {
  it("persists pending and ambiguous records across journal reload", async () => {
    const filePath = await journalPath();
    const journal = new AtomicThreadCreationJournal({ filePath });

    await journal.begin({
      operationId: OPERATION_ONE,
      cwd: "/repo",
      startedAt: STARTED_AT,
    });
    await journal.markAmbiguous(OPERATION_ONE);

    const reloaded = new AtomicThreadCreationJournal({ filePath });
    await expect(reloaded.get(OPERATION_ONE)).resolves.toEqual({
      operationId: OPERATION_ONE,
      cwd: "/repo",
      startedAt: STARTED_AT,
      status: "ambiguous",
    });
    await expect(reloaded.list()).resolves.toEqual([
      {
        operationId: OPERATION_ONE,
        cwd: "/repo",
        startedAt: STARTED_AT,
        status: "ambiguous",
      },
    ]);
  });

  it("persists confirmation and acknowledges by thread or operation ID", async () => {
    const filePath = await journalPath();
    const journal = new AtomicThreadCreationJournal({ filePath });
    await journal.begin({
      operationId: OPERATION_ONE,
      cwd: "/repo",
      startedAt: STARTED_AT,
    });
    await journal.confirm(OPERATION_ONE, THREAD_ONE);

    await expect(journal.get(OPERATION_ONE)).resolves.toMatchObject({
      operationId: OPERATION_ONE,
      status: "confirmed",
      threadId: THREAD_ONE,
    });
    await journal.acknowledge({ threadId: THREAD_ONE });
    await expect(journal.get(OPERATION_ONE)).resolves.toMatchObject({
      operationId: OPERATION_ONE,
      status: "acknowledged",
      threadId: THREAD_ONE,
    });
    await expect(
      journal.begin({ operationId: OPERATION_ONE, cwd: "/retry", startedAt: STARTED_AT }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    await journal.begin({
      operationId: OPERATION_TWO,
      cwd: "/repo/two",
      startedAt: STARTED_AT,
    });
    await journal.markAmbiguous(OPERATION_TWO);
    await journal.acknowledge({ operationId: OPERATION_TWO });
    await expect(journal.get(OPERATION_TWO)).resolves.toMatchObject({ status: "acknowledged" });
    await expect(
      journal.begin({ operationId: OPERATION_TWO, cwd: "/retry", startedAt: STARTED_AT }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("tombstones definite not-sent operations and never silently reuses their keys", async () => {
    const journal = new AtomicThreadCreationJournal({ filePath: await journalPath() });
    await journal.begin({
      operationId: OPERATION_ONE,
      cwd: "/repo",
      startedAt: STARTED_AT,
    });

    await journal.markNotSent(OPERATION_ONE);

    await expect(journal.get(OPERATION_ONE)).resolves.toMatchObject({ status: "not-sent" });
    await expect(
      journal.begin({ operationId: OPERATION_ONE, cwd: "/retry", startedAt: STARTED_AT }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("rejects a thread ID already retained by an acknowledged creation", async () => {
    const journal = new AtomicThreadCreationJournal({ filePath: await journalPath() });
    await journal.begin({
      operationId: OPERATION_ONE,
      cwd: "/repo",
      startedAt: STARTED_AT,
    });
    await journal.confirm(OPERATION_ONE, THREAD_ONE);
    await journal.acknowledge({ operationId: OPERATION_ONE });
    await journal.begin({
      operationId: OPERATION_TWO,
      cwd: "/repo/two",
      startedAt: STARTED_AT,
    });

    await expect(journal.confirm(OPERATION_TWO, THREAD_ONE)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await expect(journal.acknowledge({ threadId: THREAD_ONE })).resolves.toBeUndefined();
    await expect(journal.get(OPERATION_ONE)).resolves.toMatchObject({
      status: "acknowledged",
      threadId: THREAD_ONE,
    });
    await expect(journal.get(OPERATION_TWO)).resolves.toMatchObject({ status: "pending" });
  });

  it("fails closed when persisted confirmed and acknowledged records share a thread ID", async () => {
    const filePath = await journalPath();
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      `${JSON.stringify({
        version: 1,
        records: {
          [OPERATION_ONE]: {
            operationId: OPERATION_ONE,
            cwd: "/repo",
            startedAt: STARTED_AT,
            status: "acknowledged",
            threadId: THREAD_ONE,
          },
          [OPERATION_TWO]: {
            operationId: OPERATION_TWO,
            cwd: "/repo/two",
            startedAt: STARTED_AT,
            status: "confirmed",
            threadId: THREAD_ONE,
          },
        },
      })}\n`,
      "utf8",
    );

    const journal = new AtomicThreadCreationJournal({ filePath });
    await expect(journal.list()).rejects.toMatchObject({ code: "CONFIGURATION" });
  });

  it("bounds active records independently from acknowledged and not-sent tombstones", async () => {
    const journal = new AtomicThreadCreationJournal({
      filePath: await journalPath(),
      maxActiveRecords: 1,
      maxTotalRecords: 3,
    });
    await journal.begin({
      operationId: OPERATION_ONE,
      cwd: "/repo",
      startedAt: STARTED_AT,
    });
    await journal.confirm(OPERATION_ONE, THREAD_ONE);
    await journal.acknowledge({ operationId: OPERATION_ONE });

    await expect(
      journal.begin({
        operationId: OPERATION_TWO,
        cwd: "/repo/two",
        startedAt: STARTED_AT,
      }),
    ).resolves.toBeUndefined();

    await expect(
      journal.begin({
        operationId: OPERATION_THREE,
        cwd: "/repo/three",
        startedAt: STARTED_AT,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await journal.markNotSent(OPERATION_TWO);
    await expect(
      journal.begin({
        operationId: OPERATION_THREE,
        cwd: "/repo/three",
        startedAt: STARTED_AT,
      }),
    ).resolves.toBeUndefined();
  });

  it("reserves a finite total record slot before start and never fails sent transitions", async () => {
    const journal = new AtomicThreadCreationJournal({
      filePath: await journalPath(),
      maxActiveRecords: 1,
      maxTotalRecords: 2,
    });
    await journal.begin({
      operationId: OPERATION_ONE,
      cwd: "/repo",
      startedAt: STARTED_AT,
    });
    await journal.markNotSent(OPERATION_ONE);
    await journal.begin({
      operationId: OPERATION_TWO,
      cwd: "/repo/two",
      startedAt: STARTED_AT,
    });

    await expect(journal.markNotSent(OPERATION_TWO)).resolves.toBeUndefined();
    await expect(
      journal.begin({
        operationId: OPERATION_THREE,
        cwd: "/repo/three",
        startedAt: STARTED_AT,
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("total durable record limit"),
      remediation: expect.stringContaining("terminal tombstones"),
    });
  });

  it("validates operation, timestamp, cwd, thread IDs, and named capacity limits", async () => {
    const journal = new AtomicThreadCreationJournal({
      filePath: await journalPath(),
      maxActiveRecords: 1,
      maxTotalRecords: 2,
    });
    await journal.begin({
      operationId: OPERATION_ONE,
      cwd: "/repo",
      startedAt: STARTED_AT,
    });

    await expect(
      journal.begin({ operationId: "bad", cwd: "/repo", startedAt: STARTED_AT }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      journal.begin({ operationId: OPERATION_TWO, cwd: "relative", startedAt: "yesterday" }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(journal.confirm(OPERATION_ONE, "thread-one")).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    expect(
      () =>
        new AtomicThreadCreationJournal({
          filePath: "/tmp/thread-creations.json",
          maxActiveRecords: 2,
          maxTotalRecords: 1,
        }),
    ).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
  });
});
