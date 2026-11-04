import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { injectConfigPath, loadInjectConfig, writeInjectConfig } from "../../src/inject/config.js";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "inj-config-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("inject config", () => {
  it("lives next to the other per-instance files", () => {
    expect(injectConfigPath("/state/instances/abc")).toBe("/state/instances/abc/inject.json");
  });

  it("treats a missing file as disabled", async () => {
    expect(await loadInjectConfig(join(directory, "inject.json"))).toBeUndefined();
  });

  it("treats an explicitly disabled file as disabled", async () => {
    const path = join(directory, "inject.json");
    await writeFile(path, JSON.stringify({ version: 1, enabled: false }));

    expect(await loadInjectConfig(path)).toBeUndefined();
  });

  it("loads the log channel of an enabled file", async () => {
    const path = join(directory, "inject.json");
    await writeFile(
      path,
      JSON.stringify({ version: 1, enabled: true, logChannelId: "100000000000000020" }),
    );

    expect(await loadInjectConfig(path)).toEqual({ logChannelId: "100000000000000020" });
  });

  it("enables inject without a log channel", async () => {
    const path = join(directory, "inject.json");
    await writeFile(path, JSON.stringify({ version: 1, enabled: true }));

    expect(await loadInjectConfig(path)).toEqual({});
  });

  it("rejects a malformed file instead of silently disabling inject", async () => {
    const path = join(directory, "inject.json");
    await writeFile(path, JSON.stringify({ version: 1, enabled: true, logChannelId: "abc" }));

    await expect(loadInjectConfig(path)).rejects.toMatchObject({ code: "CONFIGURATION" });
  });

  it("writes an owner-only file that loads back", async () => {
    const path = join(directory, "inject.json");

    await writeInjectConfig(path, { enabled: true, logChannelId: "100000000000000020" });

    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      version: 1,
      enabled: true,
      logChannelId: "100000000000000020",
    });
    expect(await loadInjectConfig(path)).toEqual({ logChannelId: "100000000000000020" });
  });
});
