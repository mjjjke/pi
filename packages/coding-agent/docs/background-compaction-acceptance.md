# Stream D acceptance checkpoint

Phase 1 is NOT READY. Baseline: `8f0c924a0`, branch `feat/bgc-session`.

This worktree-local checkpoint supplements the external report-D.md. The request both asks to update that report under `~/.pi` and forbids touching `~/.pi`; conservatively no external report is written. Coordinator must reconcile it.

## Step a: gate wait evidence

`test/suite/agent-session-background-compaction.test.ts` now directly counts stream invocations across stopped mid-run, post-run, virtual preparation and overflow waits: zero requests after stop, aborted settlement, queued user retained, summary survives, one later install and one user receipt. Mid-run case uses an all-zero usage assistant and a huge actual tool result. Virtual route selects a registered smaller physical model (runtime intentionally ignores limits supplied only on a returned model object). SDK input-hook preflight spanning manual wait release queues once without starting a run. Existing gate-1, manual/Escape and RPC tests retained.

Verification: full `npm run check` green; three focused files (core background, interactive Escape, RPC background), 36 tests passed. All commands PI_OFFLINE=1 with temporary HOME, no network/paid calls. No implementation bug reproduced in these added schedules: initial failures were fixture issues (faux synthesizes usage; virtual routing resolves canonical catalog model; fauxAssistantMessage does not accept a usage option). No model-facing text added.

Not a claim of exhaustive §15 acceptance: remaining ownership/property, lifecycle, usage and documentation steps follow; independent review pending.
