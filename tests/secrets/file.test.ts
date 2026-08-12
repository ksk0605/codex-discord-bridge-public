import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileCredentialStore } from "../../src/secrets/file.js";

const temporaryDirectories: string[] = [];

async function fixture(): Promise<{
  credentialsDirectory: string;
  store: FileCredentialStore;
}> {
  const root = await mkdtemp(join(tmpdir(), "codex-discord-credentials-"));
  temporaryDirectories.push(root);
  return {
    credentialsDirectory: join(root, "credentials"),
    store: new FileCredentialStore({ stateRoot: root }),
  };
}

function recordPath(credentialsDirectory: string, account: string): string {
  const digest = createHash("sha256").update(account, "utf8").digest("hex");
  return join(credentialsDirectory, `${digest}.json`);
}

async function expectConfiguration(operation: () => Promise<unknown>): Promise<void> {
  await expect(operation()).rejects.toMatchObject({ code: "CONFIGURATION" });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

describe("FileCredentialStore", () => {
  it("stores an exact token in a private credential directory", async () => {
    const { credentialsDirectory, store } = await fixture();

    await store.set("bot-one", "discord-token-value");

    expect(await store.get("bot-one")).toBe("discord-token-value");
    expect((await stat(credentialsDirectory)).mode & 0o777).toBe(0o700);
    const entries = await readdir(credentialsDirectory);
    expect(entries).toEqual([
      `${createHash("sha256").update("bot-one", "utf8").digest("hex")}.json`,
    ]);
    expect(
      (
        await stat(
          join(
            credentialsDirectory,
            `${createHash("sha256").update("bot-one", "utf8").digest("hex")}.json`,
          ),
        )
      ).mode & 0o777,
    ).toBe(0o600);
  });

  it("replaces a stored token atomically and byte-sorts listed accounts", async () => {
    const { store } = await fixture();

    await store.set("zeta", "first-token");
    await store.set("alpha", "second-token");
    await store.set("zeta", "replacement-token");

    await expect(store.get("zeta")).resolves.toBe("replacement-token");
    await expect(store.listAccounts()).resolves.toEqual(["alpha", "zeta"]);
  });

  it("deletes credentials and maps missing records to NOT_FOUND", async () => {
    const { store } = await fixture();

    await store.set("bot-one", "discord-token-value");
    await store.delete("bot-one");

    await expect(store.get("bot-one")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(store.delete("bot-one")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(store.listAccounts()).resolves.toEqual([]);
  });

  it("rejects a symbolic-link credential directory without changing its target", async () => {
    const { credentialsDirectory, store } = await fixture();
    const targetDirectory = await mkdtemp(join(tmpdir(), "codex-discord-credential-target-"));
    temporaryDirectories.push(targetDirectory);
    const targetMode = (await stat(targetDirectory)).mode & 0o777;

    await symlink(targetDirectory, credentialsDirectory);

    await expectConfiguration(async () => await store.set("bot-one", "discord-token-value"));
    expect((await stat(targetDirectory)).mode & 0o777).toBe(targetMode);
    await expect(readdir(targetDirectory)).resolves.toEqual([]);
  });

  it("rejects a credential path that is not a directory", async () => {
    const { credentialsDirectory, store } = await fixture();
    await writeFile(credentialsDirectory, "not-a-directory", "utf8");

    await expectConfiguration(async () => await store.set("bot-one", "discord-token-value"));
  });

  it("rejects a symbolic-link credential record without reading or chmodding its target", async () => {
    const { credentialsDirectory, store } = await fixture();
    const account = "bot-one";
    const targetPath = join(credentialsDirectory, "outside.json");
    await mkdir(credentialsDirectory, { recursive: true });
    await writeFile(targetPath, JSON.stringify({ account, token: "outside-token" }), "utf8");
    await chmod(targetPath, 0o644);
    const targetContents = await readFile(targetPath, "utf8");
    const targetMode = (await stat(targetPath)).mode & 0o777;
    await symlink(targetPath, recordPath(credentialsDirectory, account));

    await expectConfiguration(async () => await store.get(account));

    expect(await readFile(targetPath, "utf8")).toBe(targetContents);
    expect((await stat(targetPath)).mode & 0o777).toBe(targetMode);
  });

  it("rejects a non-regular credential record", async () => {
    const { credentialsDirectory, store } = await fixture();
    const account = "bot-one";
    await mkdir(recordPath(credentialsDirectory, account), { recursive: true });

    await expectConfiguration(async () => await store.get(account));
  });

  it("rejects malformed and group-readable credential records", async () => {
    const { credentialsDirectory, store } = await fixture();
    const malformedAccount = "malformed";
    const readableAccount = "readable";
    await mkdir(credentialsDirectory, { recursive: true });
    await writeFile(recordPath(credentialsDirectory, malformedAccount), "{", "utf8");
    await chmod(recordPath(credentialsDirectory, malformedAccount), 0o600);
    await writeFile(
      recordPath(credentialsDirectory, readableAccount),
      JSON.stringify({ account: readableAccount, token: "discord-token-value" }),
      "utf8",
    );
    await chmod(recordPath(credentialsDirectory, readableAccount), 0o644);

    await expectConfiguration(async () => await store.get(malformedAccount));
    await expectConfiguration(async () => await store.get(readableAccount));
  });
});
