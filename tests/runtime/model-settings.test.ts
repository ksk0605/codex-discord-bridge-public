import { describe, expect, it } from "vitest";
import type { CodexModelCatalogEntry } from "../../src/app-server/session.js";
import { BridgeError } from "../../src/domain/errors.js";
import {
  findModelById,
  resolveModelSettings,
  selectVisibleModel,
} from "../../src/runtime/model-settings.js";

function model(overrides: Partial<CodexModelCatalogEntry> = {}): CodexModelCatalogEntry {
  return {
    id: "sol-id",
    model: "sol-request",
    displayName: "Sol",
    hidden: false,
    isDefault: true,
    defaultReasoningEffort: "low",
    supportedReasoningEfforts: ["low", "high"],
    ...overrides,
  };
}

const catalog = [
  model(),
  model({
    id: "luna-id",
    model: "luna-request",
    displayName: "Luna",
    isDefault: false,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["low", "medium", "high"],
  }),
  model({
    id: "hidden-id",
    model: "hidden-request",
    displayName: "Hidden",
    hidden: true,
    isDefault: false,
    defaultReasoningEffort: "high",
    supportedReasoningEfforts: ["high"],
  }),
] as const;

function expectBridgeCode(operation: () => unknown, code: string): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(BridgeError);
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected BridgeError ${code}`);
}

describe("resolveModelSettings", () => {
  it("gives binding overrides precedence and keeps persisted hidden models usable", () => {
    expect(
      resolveModelSettings({
        binding: { modelId: "luna-id", reasoningEffort: "high" },
        workspaceModel: "sol-request",
        catalog,
      }),
    ).toEqual({
      modelId: "luna-id",
      requestModel: "luna-request",
      displayName: "Luna",
      hidden: false,
      modelSource: "binding",
      reasoningEffort: "high",
      reasoningSource: "binding",
      supportedReasoningEfforts: ["low", "medium", "high"],
    });

    expect(resolveModelSettings({ binding: { modelId: "hidden-id" }, catalog })).toMatchObject({
      modelId: "hidden-id",
      hidden: true,
      reasoningEffort: "high",
      reasoningSource: "model-default",
    });
  });

  it("inherits a unique workspace request model before the catalog default", () => {
    expect(
      resolveModelSettings({
        binding: {},
        workspaceModel: "luna-request",
        catalog,
      }),
    ).toMatchObject({
      modelId: "luna-id",
      requestModel: "luna-request",
      modelSource: "workspace",
      reasoningEffort: "medium",
      reasoningSource: "model-default",
    });
  });

  it("uses exactly one catalog default when no override or workspace model exists", () => {
    expect(resolveModelSettings({ binding: {}, catalog })).toMatchObject({
      modelId: "sol-id",
      requestModel: "sol-request",
      modelSource: "catalog",
      reasoningEffort: "low",
      reasoningSource: "model-default",
    });
  });

  it("fails closed on stale, ambiguous, or unsupported settings", () => {
    expectBridgeCode(
      () => resolveModelSettings({ binding: { modelId: "missing" }, catalog }),
      "CONFIGURATION",
    );
    expectBridgeCode(
      () =>
        resolveModelSettings({
          binding: {},
          workspaceModel: "missing-request",
          catalog,
        }),
      "CONFIGURATION",
    );
    expectBridgeCode(
      () =>
        resolveModelSettings({
          binding: {},
          workspaceModel: "same-request",
          catalog: [
            model({ model: "same-request" }),
            model({ id: "other", model: "same-request", isDefault: false }),
          ],
        }),
      "CONFIGURATION",
    );
    expectBridgeCode(
      () =>
        resolveModelSettings({
          binding: {},
          catalog: [model({ isDefault: false })],
        }),
      "CONFIGURATION",
    );
    expectBridgeCode(
      () =>
        resolveModelSettings({
          binding: {},
          catalog: [model(), model({ id: "other", model: "other" })],
        }),
      "CONFIGURATION",
    );
    expectBridgeCode(
      () =>
        resolveModelSettings({
          binding: { modelId: "sol-id", reasoningEffort: "ultra" },
          catalog,
        }),
      "CONFIGURATION",
    );
  });
});

describe("model catalog lookup", () => {
  it("finds hidden and visible persisted IDs but only selects visible new models", () => {
    expect(findModelById(catalog, "hidden-id")?.displayName).toBe("Hidden");
    expect(selectVisibleModel(catalog, "luna-id").displayName).toBe("Luna");
    expectBridgeCode(() => selectVisibleModel(catalog, "hidden-id"), "INVALID_ARGUMENT");
    expectBridgeCode(() => selectVisibleModel(catalog, "missing"), "INVALID_ARGUMENT");
  });
});
