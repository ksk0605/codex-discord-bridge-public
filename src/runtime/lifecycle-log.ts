import { appendFileSync, existsSync, renameSync, statSync } from "node:fs";
export interface RuntimeDiagnostic {
  messageId: string;
  phase: string;
  turnId?: string;
}
export function createRuntimeLog(path: string) {
  return (event: RuntimeDiagnostic): void => {
    if (!/^[0-9]{1,22}$/.test(event.messageId) || !/^[a-z-]{1,48}$/.test(event.phase)) return;
    if (existsSync(path) && statSync(path).size >= 512 * 1024) renameSync(path, `${path}.previous`);
    appendFileSync(
      path,
      `${JSON.stringify({
        at: new Date().toISOString(),
        messageId: event.messageId,
        phase: event.phase,
        ...(event.turnId && /^[a-zA-Z0-9-]{1,80}$/.test(event.turnId)
          ? { turnId: event.turnId }
          : {}),
      })}\n`,
      { mode: 0o600 },
    );
  };
}
