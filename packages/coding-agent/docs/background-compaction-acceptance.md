# Stream D acceptance checkpoint

Phase 1 is NOT READY. Baseline: `8f0c924a0`, branch `feat/bgc-session`.

This worktree-local checkpoint supplements the external report-D.md. The request both asks to update that report under `~/.pi` and forbids touching `~/.pi`; conservatively no external report is written. Coordinator must reconcile it.

## Step a: gate wait evidence

`test/suite/agent-session-background-compaction.test.ts` now directly counts stream invocations across stopped mid-run, post-run, virtual preparation and overflow waits: zero requests after stop, aborted settlement, queued user retained, summary survives, one later install and one user receipt. Mid-run case uses an all-zero usage assistant and a huge actual tool result. Virtual route selects a registered smaller physical model (runtime intentionally ignores limits supplied only on a returned model object). SDK input-hook preflight spanning manual wait release queues once without starting a run. Existing gate-1, manual/Escape and RPC tests retained.

Verification: full `npm run check` green; three focused files (core background, interactive Escape, RPC background), 36 tests passed. All commands PI_OFFLINE=1 with temporary HOME, no network/paid calls. No implementation bug reproduced in these added schedules: initial failures were fixture issues (faux synthesizes usage; virtual routing resolves canonical catalog model; fauxAssistantMessage does not accept a usage option). No model-facing text added.

Not a claim of exhaustive §15 acceptance: remaining ownership/property, lifecycle, usage and documentation steps follow; independent review pending.

## Step b: red checkpoint

`test/suite/agent-session-custom-order.test.ts`: a passive sent by agent_end is receipted in the final flush; its public receipt listener accepts a trigger and rider after the continuation loop exited. Reproduced: journal contains only the passive, trigger/rider remain owned indefinitely, only one request. Expected: settle the old run, then pump one new run with trigger+rider. This is a behavioral failure against step-a commit, not a fixture error. Regression committed separately (`20926ce3b`) before its fix. `_emitAgentSettled` now schedules the next eligible custom handle as a deferred settled action, after clearing active-run ownership, checking stop/admission/write guards again before removing only its own handle. Its riders stay attached; aborted settlements never wake it.

Added 12 seeded schedules (3 seeds × all/one-at-a-time × stop/no-stop), mixed passive/steer/follow-up and three keys, first/second transient append failures, bounded recovery via one idle stop; each request equals the canonical projection, every accepted item has one receipt, same-key non-follow-up order is preserved, no owned handles remain. These are not the full property matrix including reload/waits/installs. Full check green; seven-file ownership/runtime/background regression: 129 tests passed. No new model text.

## Step c: lifecycle red checkpoint and contract evidence

Real-session test `suite/agent-session-background-api.test.ts` disposes while a session_compact handler awaits after append: reproduced two bugs, the next extension handler runs on the invalidated runtime and public applied is hidden by listener disposal (0 instead of 1). Cancel correctly returns false; reload correctly refuses while the manual reservation is held; one irreversible entry remains. Tests committed separately from fixes.

Reload-during-wait ambiguity: `src/core/agent-session.ts:reload` checks `_isAgentRunActive || isCompacting || _readiness` before background cancellation. Test records that reload in a claimed manual wait rejects without invalidating the runner/job; abort releases it, then reload cancels and ignores late completion. Design §6/§15.3 instead says reload terminates a claimed job. This is an unresolved contract mismatch, not permission to relax admission/readiness guards. Terminal extension intent before synchronous disposal is also not established: owner events use an asynchronous serialized queue, whereas dispose invalidates immediately. No new model text.
