import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { AuthorizedDiscordSendFileArguments } from "../../src/app-server/session.js";
import type { AuthorizedOutboundFile } from "../../src/manager/workspaces.js";
import {
  type DynamicFileCall,
  TurnFileDeliveryCoordinator,
} from "../../src/runtime/file-delivery.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function authorizedFile(
  path = "/project/report.txt",
): AuthorizedOutboundFile & { close: ReturnType<typeof vi.fn> } {
  return {
    canonicalPath: path,
    displayFilename: path.split("/").at(-1) ?? "file",
    size: 5,
    isClosed: false,
    createReadStream: vi.fn(() => Readable.from(["hello"])),
    close: vi.fn(async () => undefined),
    async [Symbol.asyncDispose]() {
      await this.close();
    },
  };
}

function call(callId: string, path = "/project/report.txt", message?: string): DynamicFileCall {
  return {
    callId,
    arguments: { path, ...(message === undefined ? {} : { message }) },
  };
}

function success() {
  return { success: true, contentItems: [{ type: "inputText", text: "File sent." }] };
}

function failure() {
  return {
    success: false,
    contentItems: [{ type: "inputText", text: "File could not be sent." }],
  };
}

describe("TurnFileDeliveryCoordinator", () => {
  it("replays an exact call ID once and rejects conflicting arguments", async () => {
    const authorize = vi.fn(async () => ({ file: authorizedFile(), message: "attached" }));
    const upload = vi.fn(async () => undefined);
    const coordinator = new TurnFileDeliveryCoordinator({ authorize, upload });

    const first = coordinator.handle(call("call-one", "/project/report.txt", "attached"));
    const replay = coordinator.handle(call("call-one", "/project/report.txt", "attached"));

    expect(replay).toBe(first);
    await expect(first).resolves.toEqual(success());
    await expect(
      coordinator.handle(call("call-one", "/project/other.txt", "attached")),
    ).resolves.toEqual(failure());
    expect(authorize).toHaveBeenCalledOnce();
    expect(upload).toHaveBeenCalledOnce();
  });

  it("shares one in-flight canonical path and closes every authorized descriptor", async () => {
    const firstFile = authorizedFile();
    const duplicateFile = authorizedFile();
    const gate = deferred<void>();
    const authorize = vi
      .fn<(input: unknown) => Promise<AuthorizedDiscordSendFileArguments>>()
      .mockResolvedValueOnce({ file: firstFile })
      .mockResolvedValueOnce({ file: duplicateFile });
    const upload = vi.fn(async () => gate.promise);
    const coordinator = new TurnFileDeliveryCoordinator({ authorize, upload });

    const first = coordinator.handle(call("call-one"));
    const duplicate = coordinator.handle(call("call-two"));
    await vi.waitFor(() => expect(authorize).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(upload).toHaveBeenCalledOnce());
    gate.resolve();

    await expect(Promise.all([first, duplicate])).resolves.toEqual([success(), success()]);
    expect(firstFile.close).toHaveBeenCalledOnce();
    expect(duplicateFile.close).toHaveBeenCalledOnce();
    expect(coordinator.successfulPaths()).toEqual(["/project/report.txt"]);
    expect(Object.isFrozen(coordinator.successfulPaths())).toBe(true);
  });

  it("releases a failed path slot so a new call ID can retry", async () => {
    const files = [authorizedFile(), authorizedFile()];
    const authorize = vi
      .fn<(input: unknown) => Promise<AuthorizedDiscordSendFileArguments>>()
      .mockResolvedValueOnce({ file: files[0] as AuthorizedOutboundFile })
      .mockResolvedValueOnce({ file: files[1] as AuthorizedOutboundFile });
    const upload = vi
      .fn<
        (
          file: AuthorizedOutboundFile,
          message: string | undefined,
          signal: AbortSignal,
        ) => Promise<void>
      >()
      .mockRejectedValueOnce(new Error("Discord failed"))
      .mockResolvedValueOnce(undefined);
    const coordinator = new TurnFileDeliveryCoordinator({ authorize, upload });

    await expect(coordinator.handle(call("call-one"))).resolves.toEqual(failure());
    await expect(coordinator.handle(call("call-two"))).resolves.toEqual(success());

    expect(upload).toHaveBeenCalledTimes(2);
    expect(files[0]?.close).toHaveBeenCalledOnce();
    expect(files[1]?.close).toHaveBeenCalledOnce();
  });

  it("limits one turn to ten in-flight or successful unique paths", async () => {
    const gates = Array.from({ length: 10 }, () => deferred<void>());
    const files = Array.from({ length: 11 }, (_value, index) =>
      authorizedFile(`/project/${String(index)}.txt`),
    );
    const authorize = vi.fn(async (input: unknown) => {
      const parsed = input as { path: string };
      const file = files.find((candidate) => candidate.canonicalPath === parsed.path);
      if (file === undefined) throw new Error("missing test file");
      return { file };
    });
    const upload = vi.fn(async (file: AuthorizedOutboundFile) => {
      const index = Number(file.displayFilename.split(".")[0]);
      return gates[index]?.promise;
    });
    const coordinator = new TurnFileDeliveryCoordinator({ authorize, upload });
    const pending = files
      .slice(0, 10)
      .map((file, index) => coordinator.handle(call(`call-${String(index)}`, file.canonicalPath)));
    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(10));

    await expect(
      coordinator.handle(call("call-overflow", files[10]?.canonicalPath)),
    ).resolves.toEqual(failure());
    expect(upload).toHaveBeenCalledTimes(10);
    expect(files[10]?.close).toHaveBeenCalledOnce();
    gates.forEach(({ resolve }) => {
      resolve();
    });
    await expect(Promise.all(pending)).resolves.toEqual(Array.from({ length: 10 }, success));
  });

  it("caps call records and rejects requests after closing", async () => {
    const authorize = vi.fn(async () => {
      throw new Error("not found");
    });
    const coordinator = new TurnFileDeliveryCoordinator({
      authorize,
      upload: vi.fn(async () => undefined),
    });

    for (let index = 0; index < 32; index += 1) {
      await expect(
        coordinator.handle(call(`call-${String(index)}`, `/missing/${String(index)}`)),
      ).resolves.toEqual(failure());
    }
    await expect(coordinator.handle(call("call-33", "/missing/33"))).resolves.toEqual(failure());
    expect(authorize).toHaveBeenCalledTimes(32);

    coordinator.closeToNewRequests();
    await expect(coordinator.handle(call("late-call"))).resolves.toEqual(failure());
    expect(authorize).toHaveBeenCalledTimes(32);
  });

  it("bounds abort settlement and closes descriptors when upload ignores its signal", async () => {
    const file = authorizedFile();
    let uploadSignal: AbortSignal | undefined;
    const upload = vi.fn(
      async (_file: AuthorizedOutboundFile, _message: string | undefined, signal: AbortSignal) => {
        uploadSignal = signal;
        return new Promise<void>(() => {});
      },
    );
    const waitFor = vi.fn(async () => false);
    const coordinator = new TurnFileDeliveryCoordinator({
      authorize: vi.fn(async () => ({ file })),
      upload,
      waitFor,
    });
    const abandoned = coordinator.handle(call("call-one"));
    await vi.waitFor(() => expect(upload).toHaveBeenCalledOnce());

    await expect(coordinator.abortAndWait(50)).resolves.toBe(false);

    expect(uploadSignal?.aborted).toBe(true);
    expect(file.close).toHaveBeenCalledOnce();
    expect(waitFor).toHaveBeenCalledWith(expect.any(Promise), 50);
    expect(() => coordinator.forceRelease()).not.toThrow();
    expect(coordinator.successfulPaths()).toEqual([]);
    void abandoned;
  });

  it("waits for accepted calls without aborting their uploads", async () => {
    const gate = deferred<void>();
    const waitFor = vi.fn(async () => false);
    let uploadSignal: AbortSignal | undefined;
    const coordinator = new TurnFileDeliveryCoordinator({
      authorize: vi.fn(async () => ({ file: authorizedFile() })),
      upload: vi.fn(async (_file, _message, signal) => {
        uploadSignal = signal;
        return gate.promise;
      }),
      waitFor,
    });
    const pending = coordinator.handle(call("call-one"));
    await vi.waitFor(() => expect(uploadSignal).toBeDefined());

    coordinator.closeToNewRequests();
    await expect(coordinator.waitForSettled(25)).resolves.toBe(false);

    expect(uploadSignal?.aborted).toBe(false);
    expect(waitFor).toHaveBeenCalledWith(expect.any(Promise), 25);
    gate.resolve();
    await pending;
  });
});
