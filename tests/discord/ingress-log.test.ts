import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createIngressLog } from "../../src/discord/ingress-log.js";

it("keeps bounded durable lifecycle metadata without arbitrary message properties", () => {
  const dir = mkdtempSync(join(tmpdir(), "ingress-log-"));
  try {
    const path = join(dir, "ingress.jsonl"),
      log = createIngressLog(path, 1);
    const input = {
      phase: "received" as const,
      messageId: "123",
      channelId: "456",
      content: "SECRET_MESSAGE",
    };
    log(input);
    log({ ...input, phase: "failed", stage: "access", errorCode: "ELOCKED" });
    const previous = readFileSync(`${path}.previous`, "utf8"),
      current = readFileSync(path, "utf8");
    expect(JSON.parse(previous).phase).toBe("received");
    expect(JSON.parse(current)).toMatchObject({
      messageId: "123",
      phase: "failed",
      errorCode: "ELOCKED",
    });
    expect(previous + current).not.toContain("SECRET_MESSAGE");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
