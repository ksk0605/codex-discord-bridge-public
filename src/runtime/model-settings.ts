import type { CodexModelCatalogEntry } from "../app-server/session.js";
import { BridgeError } from "../domain/errors.js";
import type { AgentModelSettings } from "../domain/schemas.js";

export interface ResolveModelSettingsInput {
  readonly binding: AgentModelSettings;
  readonly workspaceModel?: string;
  readonly catalog: readonly CodexModelCatalogEntry[];
}

export interface EffectiveModelSettings {
  readonly modelId: string;
  readonly requestModel: string;
  readonly displayName: string;
  readonly hidden: boolean;
  readonly modelSource: "binding" | "workspace" | "catalog";
  readonly reasoningEffort: string;
  readonly reasoningSource: "binding" | "model-default";
  readonly supportedReasoningEfforts: readonly string[];
}

export interface ModelSettingsStatus {
  readonly configuredModelId?: string;
  readonly configuredReasoningEffort?: string;
  readonly effective?: EffectiveModelSettings;
  readonly configurationError?: string;
}

export interface ModelSummary {
  readonly id: string;
  readonly displayName: string;
  readonly isDefault: boolean;
  readonly isCurrent: boolean;
  readonly defaultReasoningEffort: string;
  readonly supportedReasoningEfforts: readonly string[];
}

function configuration(message: string): BridgeError {
  return new BridgeError(
    "CONFIGURATION",
    message,
    "Reset or replace the agent model settings, then retry.",
  );
}

function invalidSelection(message: string): BridgeError {
  return new BridgeError(
    "INVALID_ARGUMENT",
    message,
    "Choose a visible model and one of its advertised reasoning efforts.",
  );
}

export function findModelById(
  catalog: readonly CodexModelCatalogEntry[],
  id: string,
): CodexModelCatalogEntry | undefined {
  return catalog.find((model) => model.id === id);
}

export function selectVisibleModel(
  catalog: readonly CodexModelCatalogEntry[],
  id: string,
): CodexModelCatalogEntry {
  const matches = catalog.filter((model) => model.id === id && !model.hidden);
  if (matches.length !== 1) {
    throw invalidSelection("The requested Codex model is unavailable.");
  }
  return matches[0] as CodexModelCatalogEntry;
}

function effectiveModel(input: ResolveModelSettingsInput): {
  readonly entry: CodexModelCatalogEntry;
  readonly source: EffectiveModelSettings["modelSource"];
} {
  if (input.binding.modelId !== undefined) {
    const matches = input.catalog.filter((model) => model.id === input.binding.modelId);
    if (matches.length !== 1) {
      throw configuration("The configured Codex model is no longer available.");
    }
    return { entry: matches[0] as CodexModelCatalogEntry, source: "binding" };
  }

  if (input.workspaceModel !== undefined) {
    const matches = input.catalog.filter((model) => model.model === input.workspaceModel);
    if (matches.length !== 1) {
      throw configuration("The workspace Codex model does not resolve uniquely.");
    }
    return { entry: matches[0] as CodexModelCatalogEntry, source: "workspace" };
  }

  const defaults = input.catalog.filter((model) => model.isDefault);
  if (defaults.length !== 1) {
    throw configuration("The Codex model catalog does not contain exactly one default.");
  }
  return { entry: defaults[0] as CodexModelCatalogEntry, source: "catalog" };
}

export function resolveModelSettings(input: ResolveModelSettingsInput): EffectiveModelSettings {
  const selected = effectiveModel(input);
  const explicitEffort = input.binding.reasoningEffort;
  if (
    explicitEffort !== undefined &&
    !selected.entry.supportedReasoningEfforts.includes(explicitEffort)
  ) {
    throw configuration("The configured reasoning effort is unsupported by the selected model.");
  }

  return Object.freeze({
    modelId: selected.entry.id,
    requestModel: selected.entry.model,
    displayName: selected.entry.displayName,
    hidden: selected.entry.hidden,
    modelSource: selected.source,
    reasoningEffort: explicitEffort ?? selected.entry.defaultReasoningEffort,
    reasoningSource: explicitEffort === undefined ? "model-default" : "binding",
    supportedReasoningEfforts: Object.freeze([...selected.entry.supportedReasoningEfforts]),
  });
}
