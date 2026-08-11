import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DiscordAttachmentBatchInput,
  DiscordAttachmentStore,
  type DiscordAttachmentStoreOptions,
  type DiscordMessageAttachment,
} from "../../src/discord/attachments.js";
import { MAX_DISCORD_FILE_BYTES } from "../../src/discord/format.js";

const CHANNEL_ID = "100000000000000001";
const MESSAGE_ID = "100000000000000002";
const ATTACHMENT_ID = "100000000000000003";

let temporaryDirectory: string;
let stagingDirectory: string;
let inboxDirectory: string;

function attachment(overrides: Partial<DiscordMessageAttachment> = {}): DiscordMessageAttachment {
  return {
    id: ATTACHMENT_ID,
    filename: "report.txt",
    size: 5,
    contentType: "text/plain",
    url: `https://cdn.discordapp.com/attachments/${CHANNEL_ID}/${ATTACHMENT_ID}/report.txt?ex=signed`,
    ...overrides,
  };
}

function batch(attachments: readonly DiscordMessageAttachment[]): DiscordAttachmentBatchInput {
  return { channelId: CHANNEL_ID, messageId: MESSAGE_ID, attachments };
}

function response(body: string | null, status = 200, contentLength?: number): Response {
  return new Response(body, {
    status,
    ...(contentLength === undefined
      ? {}
      : { headers: { "Content-Length": String(contentLength) } }),
  });
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function store(
  fetchImplementation: typeof fetch,
  overrides: Partial<DiscordAttachmentStoreOptions> = {},
): DiscordAttachmentStore {
  return new DiscordAttachmentStore({
    inboxDirectory,
    stagingDirectory,
    fetch: fetchImplementation,
    ...overrides,
  });
}

async function children(path: string): Promise<string[]> {
  return (await readdir(path)).sort();
}

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "codex-discord-attachments-"));
  stagingDirectory = join(temporaryDirectory, "instances", "binding", "attachment-staging");
  inboxDirectory = join(temporaryDirectory, "inbox", "binding");
  await Promise.all([
    mkdir(stagingDirectory, { recursive: true, mode: 0o700 }),
    mkdir(inboxDirectory, { recursive: true, mode: 0o700 }),
  ]);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(temporaryDirectory, { force: true, recursive: true });
});

describe("DiscordAttachmentStore", () => {
  it("treats encoded separators in an opaque Discord signature query as valid", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () => response("hello", 200, 5));
    const attachmentStore = store(fetchImplementation);
    await attachmentStore.initialize();

    await expect(
      attachmentStore.persist(
        batch([
          attachment({
            url: `https://cdn.discordapp.com/attachments/${CHANNEL_ID}/${ATTACHMENT_ID}/report.txt?signature=a%2Fb%5Cc`,
          }),
        ]),
      ),
    ).resolves.toHaveLength(1);
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it("preserves a committed inbox batch when post-publication sync fails", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () => response("hello", 200, 5));
    let syncCount = 0;
    const attachmentStore = store(fetchImplementation, {
      fileSystem: {
        syncDirectory: vi.fn(async () => {
          syncCount += 1;
          if (syncCount === 2) throw new Error("inbox sync failed");
        }),
      },
    });
    await attachmentStore.initialize();

    await expect(attachmentStore.persist(batch([attachment()]))).rejects.toThrow();

    expect(await children(stagingDirectory)).toEqual([]);
    const published = await children(inboxDirectory);
    expect(published).toHaveLength(1);
    expect(
      await readFile(
        join(inboxDirectory, published[0] as string, `${ATTACHMENT_ID}-report.txt`),
        "utf8",
      ),
    ).toBe("hello");
  });

  it("waits for an in-progress publication rename and reports the committed batch", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () => response("hello", 200, 5));
    const renamed = deferred();
    const releaseRename = deferred();
    const attachmentStore = store(fetchImplementation, {
      fileSystem: {
        publishDirectory: vi.fn(async (source, destination) => {
          await rename(source, destination);
          renamed.resolve();
          await releaseRename.promise;
        }),
      },
    });
    await attachmentStore.initialize();
    const persistence = attachmentStore.persist(batch([attachment()]));
    await renamed.promise;

    let stopped = false;
    const stopping = attachmentStore.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    releaseRename.resolve();

    await expect(persistence).resolves.toHaveLength(1);
    await stopping;
    expect(await children(inboxDirectory)).toHaveLength(1);
  });

  it("rejects publication when the inbox directory identity changes after initialization", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () => response("hello", 200, 5));
    const attachmentStore = store(fetchImplementation);
    await attachmentStore.initialize();
    const originalInbox = `${inboxDirectory}-original`;
    await rename(inboxDirectory, originalInbox);
    await mkdir(inboxDirectory, { mode: 0o700 });

    await expect(attachmentStore.persist(batch([attachment()]))).rejects.toThrow();

    expect(fetchImplementation).not.toHaveBeenCalled();
    expect(await children(inboxDirectory)).toEqual([]);
  });

  it("cannot become ready when stop races initialization", async () => {
    const readdirStarted = deferred();
    const releaseReaddir = deferred();
    const attachmentStore = store(vi.fn<typeof fetch>(), {
      fileSystem: {
        readdir: vi.fn(async () => {
          readdirStarted.resolve();
          await releaseReaddir.promise;
          return [];
        }),
      },
    });
    const initialization = attachmentStore.initialize();
    await readdirStarted.promise;
    const stopping = attachmentStore.stop();
    releaseReaddir.resolve();

    await expect(initialization).rejects.toThrow();
    await stopping;
    await expect(attachmentStore.persist(batch([attachment()]))).rejects.toThrow();
  });

  it("publishes a complete owner-only batch and returns canonical local records", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () => response("hello", 200, 5));
    const attachmentStore = store(fetchImplementation);
    await attachmentStore.initialize();

    const stored = await attachmentStore.persist(batch([attachment()]));

    expect(stored).toEqual([
      {
        id: ATTACHMENT_ID,
        filename: "report.txt",
        size: 5,
        contentType: "text/plain",
        localPath: expect.stringContaining(`${ATTACHMENT_ID}-report.txt`),
      },
    ]);
    const local = stored[0];
    if (local === undefined) throw new Error("missing stored attachment");
    expect(basename(dirname(local.localPath))).toMatch(new RegExp(`^${MESSAGE_ID}-`));
    expect(await readFile(local.localPath, "utf8")).toBe("hello");
    expect((await stat(local.localPath)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(local.localPath))).mode & 0o777).toBe(0o700);
    expect(await children(stagingDirectory)).toEqual([]);
    expect(await children(inboxDirectory)).toHaveLength(1);
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(local)).toBe(true);
    expect(fetchImplementation).toHaveBeenCalledWith(
      attachment().url,
      expect.objectContaining({ redirect: "error", signal: expect.any(AbortSignal) }),
    );
  });

  it("prefixes sanitized duplicate filenames with their attachment IDs", async () => {
    const secondId = "100000000000000004";
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response("first", 200, 5))
      .mockResolvedValueOnce(response("other", 200, 5));
    const attachmentStore = store(fetchImplementation);
    await attachmentStore.initialize();

    const stored = await attachmentStore.persist(
      batch([
        attachment({ filename: "../../bad\u0000:name?.txt" }),
        attachment({
          id: secondId,
          filename: "../../bad\u0000:name?.txt",
          url: `https://media.discordapp.net/attachments/${CHANNEL_ID}/${secondId}/anything.txt`,
        }),
      ]),
    );

    expect(stored.map(({ filename }) => filename)).toEqual(["bad_name_.txt", "bad_name_.txt"]);
    expect(stored.map(({ localPath }) => basename(localPath))).toEqual([
      `${ATTACHMENT_ID}-bad_name_.txt`,
      `${secondId}-bad_name_.txt`,
    ]);
  });

  it.each([
    ["non-HTTPS", `http://cdn.discordapp.com/attachments/${CHANNEL_ID}/${ATTACHMENT_ID}/x`],
    ["uppercase host", `https://CDN.DISCORDAPP.COM/attachments/${CHANNEL_ID}/${ATTACHMENT_ID}/x`],
    [
      "lookalike host",
      `https://cdn.discordapp.com.evil.test/attachments/${CHANNEL_ID}/${ATTACHMENT_ID}/x`,
    ],
    ["credentials", `https://user@cdn.discordapp.com/attachments/${CHANNEL_ID}/${ATTACHMENT_ID}/x`],
    [
      "explicit port",
      `https://cdn.discordapp.com:443/attachments/${CHANNEL_ID}/${ATTACHMENT_ID}/x`,
    ],
    ["fragment", `https://cdn.discordapp.com/attachments/${CHANNEL_ID}/${ATTACHMENT_ID}/x#part`],
    [
      "channel mismatch",
      `https://cdn.discordapp.com/attachments/100000000000000099/${ATTACHMENT_ID}/x`,
    ],
    [
      "attachment mismatch",
      `https://cdn.discordapp.com/attachments/${CHANNEL_ID}/100000000000000099/x`,
    ],
    ["extra path", `https://cdn.discordapp.com/attachments/${CHANNEL_ID}/${ATTACHMENT_ID}/a/x`],
    [
      "encoded slash",
      `https://cdn.discordapp.com/attachments/${CHANNEL_ID}/${ATTACHMENT_ID}/a%2Fx`,
    ],
    [
      "encoded backslash",
      `https://cdn.discordapp.com/attachments/${CHANNEL_ID}/${ATTACHMENT_ID}/a%5Cx`,
    ],
    [
      "encoded dot segment",
      `https://cdn.discordapp.com/attachments/${CHANNEL_ID}/${ATTACHMENT_ID}/%2e%2e`,
    ],
    [
      "raw backslash",
      `https://cdn.discordapp.com\\attachments\\${CHANNEL_ID}\\${ATTACHMENT_ID}\\x`,
    ],
    ["whitespace", ` https://cdn.discordapp.com/attachments/${CHANNEL_ID}/${ATTACHMENT_ID}/x`],
  ])("rejects %s URLs before fetch", async (_label, url) => {
    const fetchImplementation = vi.fn<typeof fetch>();
    const attachmentStore = store(fetchImplementation);
    await attachmentStore.initialize();

    await expect(attachmentStore.persist(batch([attachment({ url })]))).rejects.toThrow();
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("rejects invalid batch counts, IDs, and declared sizes before fetch", async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    const attachmentStore = store(fetchImplementation);
    await attachmentStore.initialize();
    const eleven = Array.from({ length: 11 }, (_value, index) => {
      const id = String(100000000000000010n + BigInt(index));
      return attachment({
        id,
        url: `https://cdn.discordapp.com/attachments/${CHANNEL_ID}/${id}/x`,
      });
    });

    await expect(attachmentStore.persist(batch(eleven))).rejects.toThrow();
    await expect(
      attachmentStore.persist(batch([attachment({ size: MAX_DISCORD_FILE_BYTES + 1 })])),
    ).rejects.toThrow();
    await expect(
      attachmentStore.persist({ ...batch([attachment()]), channelId: "invalid" }),
    ).rejects.toThrow();
    await expect(
      attachmentStore.persist(batch([attachment({ contentType: "text/plain\u0085secret" })])),
    ).rejects.toThrow();
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("enforces response status, declared length, and streamed byte count", async () => {
    const cases: Array<readonly [string, typeof fetch]> = [
      ["status", vi.fn<typeof fetch>(async () => response("hello", 404, 5))],
      ["oversized header", vi.fn<typeof fetch>(async () => response("hello", 200, 6))],
      ["short body", vi.fn<typeof fetch>(async () => response("four", 200, 5))],
      ["long body", vi.fn<typeof fetch>(async () => response("longer", 200))],
      ["missing body", vi.fn<typeof fetch>(async () => response(null, 200, 5))],
    ];

    for (const [_label, fetchImplementation] of cases) {
      const attachmentStore = store(fetchImplementation);
      await attachmentStore.initialize();
      await expect(attachmentStore.persist(batch([attachment()]))).rejects.toThrow();
      expect(await children(stagingDirectory)).toEqual([]);
      expect(await children(inboxDirectory)).toEqual([]);
      await attachmentStore.stop();
    }
  });

  it("publishes nothing when a later attachment fails", async () => {
    const secondId = "100000000000000004";
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response("hello", 200, 5))
      .mockResolvedValueOnce(response("no", 500, 2));
    const attachmentStore = store(fetchImplementation);
    await attachmentStore.initialize();

    await expect(
      attachmentStore.persist(
        batch([
          attachment(),
          attachment({
            id: secondId,
            url: `https://cdn.discordapp.com/attachments/${CHANNEL_ID}/${secondId}/x`,
          }),
        ]),
      ),
    ).rejects.toThrow();
    expect(await children(stagingDirectory)).toEqual([]);
    expect(await children(inboxDirectory)).toEqual([]);
  });

  it("removes abandoned staging on initialize without touching published inbox batches", async () => {
    const abandoned = join(stagingDirectory, `${MESSAGE_ID}-abandoned`);
    const published = join(inboxDirectory, `${MESSAGE_ID}-published`);
    await Promise.all([mkdir(abandoned), mkdir(published)]);
    await Promise.all([
      writeFile(join(abandoned, "partial"), "partial"),
      writeFile(join(published, "kept"), "kept"),
    ]);
    const attachmentStore = store(vi.fn<typeof fetch>());

    await attachmentStore.initialize();

    expect(await children(stagingDirectory)).toEqual([]);
    expect(await readFile(join(published, "kept"), "utf8")).toBe("kept");
  });

  it("aborts active downloads and rejects new persistence after stop", async () => {
    let sawAbort = false;
    const fetchImplementation = vi.fn<typeof fetch>(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              sawAbort = true;
              reject(new DOMException("aborted", "AbortError"));
            },
            { once: true },
          );
        }),
    );
    const attachmentStore = store(fetchImplementation, { headerTimeoutMs: 60_000 });
    await attachmentStore.initialize();
    const pending = attachmentStore.persist(batch([attachment()]));
    await vi.waitFor(() => expect(fetchImplementation).toHaveBeenCalledTimes(1));

    await attachmentStore.stop();

    await expect(pending).rejects.toThrow();
    expect(sawAbort).toBe(true);
    await expect(attachmentStore.persist(batch([attachment()]))).rejects.toThrow();
    expect(await children(stagingDirectory)).toEqual([]);
  });

  it("does not wait forever when an aborted response stream refuses cancellation", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull: async () => new Promise<void>(() => {}),
      cancel: async () => new Promise<void>(() => {}),
    });
    const fetchImplementation = vi.fn<typeof fetch>(async () =>
      Promise.resolve(new Response(body, { status: 200, headers: { "Content-Length": "5" } })),
    );
    const attachmentStore = store(fetchImplementation, {
      headerTimeoutMs: 1_000,
      idleTimeoutMs: 1_000,
      totalTimeoutMs: 2_000,
    });
    await attachmentStore.initialize();
    const pending = attachmentStore.persist(batch([attachment()]));
    await vi.waitFor(() => expect(fetchImplementation).toHaveBeenCalledTimes(1));

    const stopOutcome = Promise.race([
      attachmentStore.stop().then(() => "stopped"),
      new Promise<string>((resolve) => setTimeout(() => resolve("timed-out"), 100)),
    ]);

    await expect(stopOutcome).resolves.toBe("stopped");
    await expect(pending).rejects.toThrow();
  });

  it("bounds a fetch that never returns response headers", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () => new Promise<Response>(() => {}));
    const attachmentStore = store(fetchImplementation, {
      headerTimeoutMs: 10,
      idleTimeoutMs: 50,
      totalTimeoutMs: 100,
    });
    await attachmentStore.initialize();

    await expect(attachmentStore.persist(batch([attachment()]))).rejects.toThrow();
    expect(await children(stagingDirectory)).toEqual([]);
  });
});
