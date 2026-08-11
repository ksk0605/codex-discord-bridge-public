import { basename, isAbsolute, posix } from "node:path";
import {
  createTurnProgressEvent,
  type ProgressActivityStatus,
  type TurnProgressEvent,
} from "../runtime/turn-progress.js";
import { redactDiscordSecrets } from "./format.js";

export const MAX_RENDERED_PROGRESS_LENGTH = 1_900;
const MAX_RENDERED_FIELD_LENGTH = 1_200;

export interface RenderedProgressEvent {
  readonly streamText?: string;
  readonly type: TurnProgressEvent["type"];
  readonly text: string;
}

function truncateUtf16(value: string, maximum: number): string {
  if (value.length <= maximum) {
    return value;
  }
  const suffix = "...[TRUNCATED]";
  let end = maximum - suffix.length;
  if (
    end > 0 &&
    /[\uD800-\uDBFF]/u.test(value.charAt(end - 1)) &&
    /[\uDC00-\uDFFF]/u.test(value.charAt(end))
  ) {
    end -= 1;
  }
  return `${value.slice(0, end)}${suffix}`;
}

function sanitizeProgressText(value: string, maximum = MAX_RENDERED_FIELD_LENGTH): string {
  let safe = redactDiscordSecrets(value, {
    maxOutputLength: Math.min(16_384, Math.max(16, maximum)),
  })
    .replace(
      /https?:\/\/(?:cdn\.discordapp\.com|media\.discordapp\.net)\/[^\s)>\]]*/giu,
      "[ATTACHMENT LINK REMOVED]",
    )
    .replace(/\[([^\]\r\n]{0,512})\]\([^)]+\)/gu, "$1 [LINK REMOVED]")
    .replace(/<@!?\d+>|<@&\d+>/gu, "[MENTION]")
    .replace(/<#\d+>/gu, "[CHANNEL]")
    .replace(/@(everyone|here)\b/giu, "[AT]$1")
    .replace(
      /(^|[\s("'`=:])\/(?:Users|private|tmp|home|var|opt|Volumes|Library|Applications|System|etc|usr)(?:\/[^\s)\]}>,"'`]*)?/gmu,
      "$1[LOCAL PATH]",
    )
    .replace(/(^|[\s("'`=:])[A-Za-z]:\\[^\s)\]}>,"'`]*/gmu, "$1[LOCAL PATH]")
    .replace(/([\\`*_~|>])/gu, "\\$1");

  safe = safe.replace(/\r\n?/gu, "\n");
  return truncateUtf16(safe, maximum);
}

function safeExecutable(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  const segment = basename(normalized);
  return sanitizeProgressText(segment.length === 0 ? "[COMMAND]" : segment, 256);
}

function safeRelativePath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  if (
    isAbsolute(normalized) ||
    /^[A-Za-z]:\//u.test(normalized) ||
    /^https?:\/\//iu.test(normalized)
  ) {
    return normalized.startsWith("http") ? "[LINK REMOVED]" : "[LOCAL PATH]";
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "..")) {
    return "[LOCAL PATH]";
  }
  const relative = posix.normalize(normalized);
  if (relative === "." || relative.startsWith("../")) {
    return "[LOCAL PATH]";
  }
  return sanitizeProgressText(relative, 512);
}

function activityStatusLabel(status: ProgressActivityStatus): string {
  switch (status) {
    case "inProgress":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
  }
}

function renderActivity(event: Extract<TurnProgressEvent, { type: "activity" }>): string {
  const status = activityStatusLabel(event.status);
  switch (event.activity.kind) {
    case "command":
      return `Command ${status}: ${safeExecutable(event.activity.executable)}`;
    case "file": {
      const paths = event.activity.paths.map(safeRelativePath);
      return `Files ${status}: ${paths.length === 0 ? "no files" : paths.join(", ")}`;
    }
    case "tool": {
      const provider =
        event.activity.provider === undefined
          ? ""
          : `${sanitizeProgressText(event.activity.provider, 256)}/`;
      return `Tool ${status}: ${provider}${sanitizeProgressText(event.activity.name, 256)}`;
    }
    case "web":
      return event.activity.query === undefined
        ? `Web search ${status}`
        : `Web search ${status}: ${sanitizeProgressText(event.activity.query)}`;
    case "collaboration":
      return `Collaboration ${status}: ${sanitizeProgressText(event.activity.operation, 256)}`;
  }
}

function renderPlan(event: Extract<TurnProgressEvent, { type: "plan" }>): string {
  const lines = event.steps.map(({ status, step }) => {
    const marker = status === "completed" ? "[x]" : status === "inProgress" ? "[~]" : "[ ]";
    return `${marker} ${sanitizeProgressText(step, 512)}`;
  });
  return `Plan${lines.length === 0 ? "" : `\n${lines.join("\n")}`}`;
}

function renderTerminal(event: Extract<TurnProgressEvent, { type: "terminal" }>): string {
  const label =
    event.status === "completed"
      ? "Completed"
      : event.status === "interrupted"
        ? "Interrupted"
        : "Failed";
  return event.message === undefined ? label : `${label}: ${sanitizeProgressText(event.message)}`;
}

export function renderTurnProgressEvent(input: TurnProgressEvent): RenderedProgressEvent {
  const event = createTurnProgressEvent(input);
  let text: string;
  let streamText: string | undefined;
  switch (event.type) {
    case "state":
      text =
        event.state === "preparing" ? "Preparing" : event.state === "queued" ? "Queued" : "Running";
      break;
    case "reasoning":
      streamText = sanitizeProgressText(event.text);
      text = `Reasoning: ${streamText}`;
      break;
    case "commentary":
      streamText = sanitizeProgressText(event.text);
      text = `Update: ${streamText}`;
      break;
    case "plan":
      text = renderPlan(event);
      break;
    case "activity":
      text = renderActivity(event);
      break;
    case "warning":
      text = `Warning: ${sanitizeProgressText(event.message)}`;
      break;
    case "heartbeat":
      text = `Active at ${event.observedAt}`;
      break;
    case "terminal":
      text = renderTerminal(event);
      break;
  }
  return Object.freeze({
    ...(streamText === undefined ? {} : { streamText }),
    text: truncateUtf16(text, MAX_RENDERED_PROGRESS_LENGTH),
    type: event.type,
  });
}
