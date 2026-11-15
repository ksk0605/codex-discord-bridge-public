import { appendFileSync, existsSync, renameSync, statSync } from "node:fs";
import type { DiscordIngressDiagnostic } from "./adapter.js";

// Only lifecycle metadata is persisted: never message contents, attachments or tokens.
// Each instance owns its log. A bounded previous file keeps failures across restarts.
export function createIngressLog(filePath: string, maxBytes = 5 * 1024 * 1024) {
  return (event: DiscordIngressDiagnostic): void => {
    if (existsSync(filePath) && statSync(filePath).size >= maxBytes) {
      renameSync(filePath, `${filePath}.previous`);
    }
    const code =
      event.errorCode === undefined
        ? undefined
        : /^[A-Z0-9_]{1,64}$/.test(event.errorCode)
          ? event.errorCode
          : "UNKNOWN";
    const record = {
      at: new Date().toISOString(),
      phase: event.phase,
      messageId: event.messageId,
      channelId: event.channelId,
      stage: event.stage,
      errorCode: code,
      attempt: event.attempt,
    };
    appendFileSync(filePath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  };
}
