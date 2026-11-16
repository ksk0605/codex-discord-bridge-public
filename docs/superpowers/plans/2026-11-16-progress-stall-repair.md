# Progress stalls must not block work

Approved scope: investigate recurring completion/queue stalls, implement prevention and verify before rollout.

Evidence: persisted task #260 backend turn is completed, bridge remains running, #269 receipt remains pending/queued. Genuine session terminal read returns completed. Prior logs cannot determine the exact historical await that stalled; do not claim otherwise.

Reproduction: an unresolved progress bind prevents buffered completion from draining and leaves the serial queue occupied. Prior completion reconciliation/timeout does not release this earlier await. Test fails on c0a9f9f and passes with bounded progress operations.

Changes:
- Bound all awaited progress operations to 5 seconds and their error reporting/disable to 1 second.
- Disable failed progress pumps, heartbeat and journal activity. Send the final response independently of a failed progress receipt chain; never replay model actions.
- Reconcile against turnSession/turnBinding after connection recovery, not the disposed original session.
- Warn after three reconciliation failures; retain uncertainty rather than blindly rerun.
- Private, bounded lifecycle metadata log records phase, source message ID and turn ID only.

Validation: hung bind, hung error report, next queued turn admission, recovered-session reconciliation, active backend preservation, final transport timeout, controller cleanup; full check/tests/build. Canary actual accepted->started->terminal->settled before idle-only rollout. Persisted queued #269 restored by existing mechanism; no duplicate injection. Preserve running workers. Backup prior dist, rollback and stop rollout on canary failure. Push feature branch only after validation.
