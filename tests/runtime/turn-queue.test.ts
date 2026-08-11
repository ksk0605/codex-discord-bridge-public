import { describe, expect, it, vi } from "vitest";
import {
  TurnDiscardedError,
  type TurnInput,
  type TurnItem,
  TurnQueue,
} from "../../src/runtime/turn-queue.js";

const input = (id: string, channelId = "channel-1"): TurnInput => ({
  channelId,
  messageId: `message-${id}`,
  authorId: `author-${id}`,
  guildId: "guild-1",
  parentChannelId: "parent-1",
  interactionId: `interaction-${id}`,
  text: `text-${id}`,
  attachments: [
    {
      id: "100000000000000006",
      filename: "file.txt",
      size: 12,
      contentType: "text/plain",
      localPath: "/tmp/file.txt",
    },
  ],
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe("TurnQueue", () => {
  it("serializes a generic async FIFO across channels and returns item results", async () => {
    const runs: TurnItem[] = [];
    const gates = [deferred<string>(), deferred<string>()];
    const queue = new TurnQueue<string>({
      run: async (item) => {
        runs.push(item);
        const gate = gates[runs.length - 1];
        if (!gate) throw new Error("missing test gate");
        return gate.promise;
      },
    });

    const first = queue.enqueue(input("a", "channel-a"));
    const second = queue.enqueue(input("b", "channel-b"));
    expect(queue.depth()).toBe(2);
    expect(runs).toHaveLength(1);
    const firstGate = gates[0];
    const secondGate = gates[1];
    if (!firstGate || !secondGate) throw new Error("missing test gate");
    firstGate.resolve("A");
    await expect(first).resolves.toBe("A");
    expect(runs).toHaveLength(2);
    secondGate.resolve("B");
    await expect(second).resolves.toBe("B");
    await expect(queue.idle()).resolves.toBeUndefined();
    expect(runs.map(({ messageId }) => messageId)).toEqual(["message-a", "message-b"]);
  });

  it("passes an immutable metadata snapshot and does not retain it after settlement", async () => {
    let seen!: TurnItem;
    const queue = new TurnQueue<void>({
      run: async (item) => {
        seen = item;
      },
    });
    const original = input("immutable");
    const result = queue.enqueue(original);
    original.text = "changed";
    const originalAttachment = original.attachments?.[0];
    if (!originalAttachment) throw new Error("missing test attachment");
    (originalAttachment as { filename: string }).filename = "changed.txt";
    await result;

    expect(seen.text).toBe("text-immutable");
    const seenAttachment = seen.attachments?.[0];
    expect(seenAttachment?.filename).toBe("file.txt");
    expect(Object.isFrozen(seenAttachment)).toBe(true);
    expect(Object.isFrozen(seen)).toBe(true);
    expect(Object.isFrozen(seen.attachments)).toBe(true);
    expect(() => ((seen as { text: string }).text = "changed")).toThrow();
    expect(queue.depth()).toBe(0);
  });

  it("interrupts the active item once and coalesces concurrent calls", async () => {
    const gate = deferred<string>();
    const interrupt = vi.fn(async () => undefined);
    const queue = new TurnQueue<string>({ run: () => gate.promise, interrupt });
    queue.enqueue(input("active"));

    const results = await Promise.all([queue.interruptActive(), queue.interruptActive()]);
    expect(results).toEqual([true, true]);
    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(interrupt).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "message-active" }),
    );
    gate.resolve("done");
    await queue.idle();
    await expect(queue.interruptActive()).resolves.toBe(false);
  });

  it("interrupts a new active item while the previous interrupt callback is still pending", async () => {
    const firstRun = deferred<string>();
    const secondRun = deferred<string>();
    const firstInterrupt = deferred<void>();
    const interrupt = vi.fn((item: TurnItem) =>
      item.messageId === "message-first" ? firstInterrupt.promise : Promise.resolve(),
    );
    const queue = new TurnQueue<string>({
      run: (item) => (item.messageId === "message-first" ? firstRun.promise : secondRun.promise),
      interrupt,
    });
    const first = queue.enqueue(input("first"));
    const second = queue.enqueue(input("second"));

    const interruptingFirst = queue.interruptActive();
    firstRun.resolve("first-done");
    await expect(first).resolves.toBe("first-done");
    const interruptingSecond = queue.interruptActive();

    expect(interrupt).toHaveBeenCalledTimes(2);
    expect(interrupt).toHaveBeenLastCalledWith(
      expect.objectContaining({ messageId: "message-second" }),
    );
    await expect(interruptingSecond).resolves.toBe(true);
    firstInterrupt.resolve();
    await expect(interruptingFirst).resolves.toBe(true);
    secondRun.resolve("second-done");
    await expect(second).resolves.toBe("second-done");
  });

  it("discards only pending items with typed errors and notice metadata", async () => {
    const gate = deferred<string>();
    const queue = new TurnQueue<string>({ run: () => gate.promise });
    const active = queue.enqueue(input("active"));
    const pending = [queue.enqueue(input("one")), queue.enqueue(input("two"))];

    const discarded = queue.discardPending("shutdown");
    expect(discarded).toEqual([
      expect.objectContaining({ messageId: "message-one", channelId: "channel-1" }),
      expect.objectContaining({ messageId: "message-two", channelId: "channel-1" }),
    ]);
    expect(queue.depth()).toBe(1);
    await expect(pending[0]).rejects.toMatchObject({
      code: "CONFLICT",
      reason: "shutdown",
      messageId: "message-one",
    });
    await expect(pending[1]).rejects.toBeInstanceOf(TurnDiscardedError);
    gate.resolve("active-result");
    await expect(active).resolves.toBe("active-result");
  });

  it("continues FIFO after a failed turn and enforces bounded depth", async () => {
    const queue = new TurnQueue<string>({
      maxDepth: 2,
      run: async (item) => {
        if (item.messageId === "message-fail") throw new Error("failed");
        return item.messageId;
      },
    });
    const failed = queue.enqueue(input("fail"));
    const next = queue.enqueue(input("next"));
    expect(() => queue.enqueue(input("overflow"))).toThrowError(/queue depth/i);
    await expect(failed).rejects.toThrow("failed");
    await expect(next).resolves.toBe("message-next");
  });

  it("accepts attachment-only turns but rejects turns with no content", async () => {
    const seen: TurnItem[] = [];
    const queue = new TurnQueue<void>({
      run: async (item) => {
        seen.push(item);
      },
    });

    await expect(queue.enqueue({ ...input("attachment-only"), text: "" })).resolves.toBeUndefined();
    expect(seen[0]?.attachments).toHaveLength(1);
    expect(() => queue.enqueue({ ...input("empty"), text: "", attachments: [] })).toThrowError(
      /content|text|attachment/i,
    );
  });

  it.each([
    {
      label: "empty ID",
      attachments: [{ id: "", filename: "x", size: 1, localPath: "/tmp/x" }],
    },
    {
      label: "relative path",
      attachments: [{ id: "100000000000000006", filename: "x", size: 1, localPath: "relative/x" }],
    },
    {
      label: "negative size",
      attachments: [{ id: "100000000000000006", filename: "x", size: -1, localPath: "/tmp/x" }],
    },
    {
      label: "control path",
      attachments: [
        {
          id: "100000000000000006",
          filename: "x",
          size: 1,
          localPath: "/tmp/control\u0085x",
        },
      ],
    },
    {
      label: "extra field",
      attachments: [
        {
          id: "100000000000000006",
          filename: "x",
          size: 1,
          localPath: "/tmp/x",
          unexpected: true,
        },
      ],
    },
    {
      label: "too many files",
      attachments: Array.from({ length: 11 }, (_value, index) => ({
        id: String(100000000000000000n + BigInt(index)),
        filename: `${String(index)}.txt`,
        size: 1,
        localPath: `/tmp/${String(index)}.txt`,
      })),
    },
  ])("rejects invalid local attachment records: $label", ({ attachments }) => {
    const queue = new TurnQueue<void>({ run: async () => undefined });
    expect(() => queue.enqueue({ ...input("bad-attachment"), attachments })).toThrowError();
  });

  it.each([{} as TurnInput, { ...input("bad"), channelId: "" }])(
    "rejects invalid input fail closed",
    (invalid) => {
      const queue = new TurnQueue<void>({ run: async () => undefined });
      expect(() => queue.enqueue(invalid)).toThrowError();
    },
  );

  it("rejects invalid configuration", () => {
    expect(() => new TurnQueue({ run: undefined as never })).toThrowError();
    expect(() => new TurnQueue({ run: async () => undefined, maxDepth: 0 })).toThrowError();
  });
});
