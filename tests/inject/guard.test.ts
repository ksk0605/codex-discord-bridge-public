import { describe, expect, it } from "vitest";
import { InjectGuard } from "../../src/inject/guard.js";

function clock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

describe("InjectGuard", () => {
  it("allows a first request from a sender", () => {
    const guard = new InjectGuard({ now: clock().now });

    expect(guard.check("cron:morning", 0).allowed).toBe(true);
  });

  it("rejects requests whose hop count exceeds the limit", () => {
    const guard = new InjectGuard({ now: clock().now, maxHop: 2 });

    expect(guard.check("agent:a", 2).allowed).toBe(true);
    expect(guard.check("agent:b", 3)).toEqual({ allowed: false, reason: "hop-limit" });
  });

  it("rejects invalid hop counts", () => {
    const guard = new InjectGuard({ now: clock().now });

    expect(guard.check("agent:a", -1)).toEqual({ allowed: false, reason: "hop-limit" });
    expect(guard.check("agent:a", 1.5)).toEqual({ allowed: false, reason: "hop-limit" });
  });

  it("rejects the same sender again inside the cooldown and allows it after", () => {
    const time = clock();
    const guard = new InjectGuard({ now: time.now, senderCooldownMs: 60_000 });

    expect(guard.check("cron:morning", 0).allowed).toBe(true);
    time.advance(59_999);
    expect(guard.check("cron:morning", 0)).toEqual({ allowed: false, reason: "sender-cooldown" });
    expect(guard.check("hub:task-1", 0).allowed).toBe(true);
    time.advance(1);
    expect(guard.check("cron:morning", 0).allowed).toBe(true);
  });

  it("limits the total accepted requests inside the window", () => {
    const time = clock();
    const guard = new InjectGuard({
      now: time.now,
      senderCooldownMs: 0,
      windowMs: 600_000,
      maxPerWindow: 3,
    });

    for (const sender of ["a", "b", "c"]) {
      expect(guard.check(`hub:${sender}`, 0).allowed).toBe(true);
    }
    expect(guard.check("hub:d", 0)).toEqual({ allowed: false, reason: "rate-limit" });
    time.advance(600_000);
    expect(guard.check("hub:d", 0).allowed).toBe(true);
  });

  it("does not count rejected requests against the window", () => {
    const time = clock();
    const guard = new InjectGuard({
      now: time.now,
      senderCooldownMs: 60_000,
      maxPerWindow: 2,
    });

    expect(guard.check("hub:a", 0).allowed).toBe(true);
    expect(guard.check("hub:a", 0).allowed).toBe(false);
    expect(guard.check("hub:a", 0).allowed).toBe(false);
    expect(guard.check("hub:b", 0).allowed).toBe(true);
  });

  it("gives back the sender and window slot when a delivery is released", () => {
    const guard = new InjectGuard({ now: clock().now, maxPerWindow: 1 });

    const first = guard.check("cron:morning", 0);
    if (!first.allowed) throw new Error("expected the first request to pass");
    first.release();

    expect(guard.check("cron:morning", 0).allowed).toBe(true);
  });
});
