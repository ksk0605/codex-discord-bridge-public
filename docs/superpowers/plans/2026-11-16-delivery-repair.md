# Task delivery recovery implementation plan

Goal: preserve accepted, unstarted injected work across process restarts and prevent terminal bookkeeping from blocking subsequent turns.
Architecture: per-instance atomic delivery ledger, lifecycle hooks around the serial runtime, bounded completion reconciliation, hub receipt tracking. Existing hop/access/assignee guards remain authoritative.

- [ ] Add tested delivery ledger with pending/running/finished/uncertain states, immutable message identity, atomic writes and bounded history. Never automatically replay running/uncertain work.
- [ ] Persist injected input before returning receipt; transition running before model invocation. On shutdown leave pending entries recoverable. Replay pending only through the existing allowed destination, producing a fresh progress observation while preserving original delivery identity.
- [ ] Confirm stalled completion cause; bounded result delivery and terminal state reconciliation must not resend model actions. Add missing completion, hung transport, active backend and duplicate completion tests.
- [ ] Hub stores wake receipt and distinguishes accepted from claimed. Reconciliation queries actual delivery state before any retry, bounded attempts and explicit failure notification. No blind replay of uncertain executions.
- [ ] Full check/test/build, isolated crash/restart probe, secret scan, canary after idle with rollback. No restart of active work. Push verified feature branch only.

Safety: attachments and secrets are not copied to ledger; persisted injected text has same private instance protections as existing transcripts. Restart replay never reuses an interrupt command. No automatic deployment or company source access.
