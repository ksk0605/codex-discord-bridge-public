// Limits for turns injected from outside Discord (cron jobs, the hub, other agents).
// Defaults follow ebibibi/ebi-agent-chat-relay's RelayGuard: at most two agent-to-agent
// hops, one request per sender per minute, and a cap per ten-minute window.

export const DEFAULT_MAX_HOP = 2;
export const DEFAULT_SENDER_COOLDOWN_MS = 60_000;
export const DEFAULT_WINDOW_MS = 600_000;
export const DEFAULT_MAX_PER_WINDOW = 10;

export type InjectGuardRejection = "hop-limit" | "sender-cooldown" | "rate-limit";

export type InjectGuardDecision =
  // release() gives the slot back when the turn could not be delivered.
  | { readonly allowed: true; release(): void }
  | { readonly allowed: false; readonly reason: InjectGuardRejection };

export interface InjectGuardOptions {
  readonly maxHop?: number;
  readonly senderCooldownMs?: number;
  readonly windowMs?: number;
  readonly maxPerWindow?: number;
  readonly now?: () => number;
}

export class InjectGuard {
  private readonly maxHop: number;
  private readonly senderCooldownMs: number;
  private readonly windowMs: number;
  private readonly maxPerWindow: number;
  private readonly now: () => number;
  private readonly lastBySender = new Map<string, number>();
  private accepted: number[] = [];

  constructor(options: InjectGuardOptions = {}) {
    this.maxHop = options.maxHop ?? DEFAULT_MAX_HOP;
    this.senderCooldownMs = options.senderCooldownMs ?? DEFAULT_SENDER_COOLDOWN_MS;
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.maxPerWindow = options.maxPerWindow ?? DEFAULT_MAX_PER_WINDOW;
    this.now = options.now ?? Date.now;
  }

  check(from: string, hop: number): InjectGuardDecision {
    if (!Number.isSafeInteger(hop) || hop < 0 || hop > this.maxHop) {
      return { allowed: false, reason: "hop-limit" };
    }
    const now = this.now();
    const last = this.lastBySender.get(from);
    if (last !== undefined && now - last < this.senderCooldownMs) {
      return { allowed: false, reason: "sender-cooldown" };
    }
    this.accepted = this.accepted.filter((time) => now - time < this.windowMs);
    if (this.accepted.length >= this.maxPerWindow) {
      return { allowed: false, reason: "rate-limit" };
    }
    this.accepted.push(now);
    this.lastBySender.set(from, now);
    this.pruneSenders(now);
    let released = false;
    return {
      allowed: true,
      release: () => {
        if (released) return;
        released = true;
        const index = this.accepted.lastIndexOf(now);
        if (index !== -1) this.accepted.splice(index, 1);
        if (this.lastBySender.get(from) !== now) return;
        if (last === undefined) this.lastBySender.delete(from);
        else this.lastBySender.set(from, last);
      },
    };
  }

  private pruneSenders(now: number): void {
    for (const [sender, time] of this.lastBySender) {
      if (now - time >= this.senderCooldownMs) this.lastBySender.delete(sender);
    }
  }
}
