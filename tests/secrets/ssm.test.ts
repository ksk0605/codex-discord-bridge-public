import { describe, expect, it, vi } from "vitest";
import { BridgeError } from "../../src/domain/errors.js";
import { SsmCredentialStore, type SsmParameterClient } from "../../src/secrets/ssm.js";

function client(): SsmParameterClient {
  return {
    deleteParameter: vi.fn(async () => ({})),
    getParameter: vi.fn(async (input) => ({
      Parameter: { Name: input.Name, Value: "discord-token" },
    })),
    getParametersByPath: vi.fn(async () => ({ Parameters: [] })),
    putParameter: vi.fn(async () => ({})),
  };
}

describe("SsmCredentialStore", () => {
  it("stores bot tokens as encrypted parameters below its configured prefix", async () => {
    const ssm = client();
    const store = new SsmCredentialStore({
      client: ssm,
      keyId: "alias/codex-discord-bridge",
      prefix: "/production/codex-discord/bots",
    });

    await store.set("bot-one", "discord-token");

    expect(ssm.putParameter).toHaveBeenCalledWith({
      KeyId: "alias/codex-discord-bridge",
      Name: "/production/codex-discord/bots/bot-one",
      Overwrite: true,
      Type: "SecureString",
      Value: "discord-token",
    });
  });

  it("requests decrypted token values and maps missing parameters to NOT_FOUND", async () => {
    const ssm = client();
    const getParameter = vi.fn(async () => {
      const error = new Error("parameter does not exist");
      error.name = "ParameterNotFound";
      throw error;
    });
    ssm.getParameter = getParameter;
    const store = new SsmCredentialStore({ client: ssm, prefix: "/bridge/bots" });

    await expect(store.get("bot-one")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(getParameter).toHaveBeenCalledWith({
      Name: "/bridge/bots/bot-one",
      WithDecryption: true,
    });
  });

  it("paginates and byte-sorts only account names under its exact prefix", async () => {
    const ssm = client();
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        NextToken: "page-two",
        Parameters: [{ Name: "/bridge/bots/zeta" }, { Name: "/bridge/bots/not-an-account/child" }],
      })
      .mockResolvedValueOnce({ Parameters: [{ Name: "/bridge/bots/alpha" }] });
    ssm.getParametersByPath = list;
    const store = new SsmCredentialStore({ client: ssm, prefix: "/bridge/bots" });

    await expect(store.listAccounts()).resolves.toEqual(["alpha", "zeta"]);
    expect(list).toHaveBeenNthCalledWith(1, {
      Path: "/bridge/bots",
      Recursive: false,
      WithDecryption: false,
    });
    expect(list).toHaveBeenNthCalledWith(2, {
      NextToken: "page-two",
      Path: "/bridge/bots",
      Recursive: false,
      WithDecryption: false,
    });
  });

  it("redacts token-bearing provider errors", async () => {
    const ssm = client();
    ssm.getParameter = vi.fn(async () => {
      throw new Error("provider failed for discord-token");
    });
    const store = new SsmCredentialStore({ client: ssm, prefix: "/bridge/bots" });

    try {
      await store.get("bot-one");
      throw new Error("expected a credential error");
    } catch (error) {
      expect(error).toBeInstanceOf(BridgeError);
      expect(error).toMatchObject({ code: "RUNTIME" });
      expect(error).not.toMatchObject({ message: expect.stringContaining("discord-token") });
    }
  });
});
