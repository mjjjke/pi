# Local Pi fork

This repository is the local Pi installation. `main` is the stable integration branch; `pi-mjjjke` is the separate extension consumer repository. Never rebuild the fork by replaying an old patch series and then merging the old main history back into it.

## Upstream base

- Repository: [earendil-works/pi](https://github.com/earendil-works/pi)
- Published stable release: [v0.87.1](https://github.com/earendil-works/pi/releases/tag/v0.87.1)
- Commit: `f07218c4d4bbc12bef056a7058c3dd49dfe41abe`
- Release publication: `2026-09-22T19:43:43Z`; GitHub publication flags and the upstream tag were verified on 2026-09-23.

Keep this base accurate when preparing a new candidate. Update it only in that candidate, never in the running checkout during preparation.

## Intentional differences

Test paths below are relative to the indicated package's `test/` directory. Retiring or replacing a behavior requires explicit approval, even when upstream appears to offer an equivalent.

| Behavior | Why it exists / consumers | Regression coverage | Condition for retirement |
|---|---|---|---|
| Passive developer instructions | Persist instructions without triggering a turn; serialize supported roles and preserve them across compaction/retry. Used by `pi-collaboration-modes` and `pi-workflow-engine`. Model capabilities survive remote catalog overlays. | ai: `instruction-messages.test.ts`; agent: `harness/compaction.test.ts`; coding-agent: `compaction-serialization.test.ts`, `remote-catalog-provider.test.ts`, `suite/agent-session-prompt.test.ts`, `suite/agent-session-retry-events.test.ts`, `suite/agent-session-fork-boundaries.test.ts` | Upstream exposes the same passive API, persistence, provider behavior and boundary guarantees, and consumers pass against it. |
| Deferred session replacement | Queue replacement from `agent_end` without deadlock or early idle resolution; use a fresh context for handoff. Used by `pi-collaboration-modes`. | coding-agent: `extensions-runner.test.ts`, `suite/agent-session-fork-boundaries.test.ts`, `suite/regressions/2860-replaced-session-context.test.ts`, `trigger-compact-extension.test.ts` | Upstream provides the same deferred handoff API and lifecycle guarantees. |
| Assistant display transforms | Render boundary markers as readable status without changing session/provider messages. Used by `pi-collaboration-modes`. | coding-agent: `assistant-message-display-transform.test.ts`, `extensions-fork-api-lifecycle.test.ts`; existing compaction extension fixtures remain type-compatible. | Upstream offers display-only transforms with immutable inputs and preserved non-text content. |
| Fast mode capabilities | Advertise provider-specific fast/priority payloads and send Anthropic beta headers. Used by `pi-fast`; metadata retained by remote catalog overlays. | ai: `pi-fast-mode.test.ts`, `anthropic-sse-parsing.test.ts`; coding-agent: `remote-catalog-provider.test.ts` | Upstream supplies equivalent discovery, wire behavior and metadata preservation. |
| Anthropic subscription OAuth | Use the subscription authorization endpoint/scopes without API-key creation permission. Consumed by native Anthropic auth and the `pi-anthropic-auth` wrapper. | ai: `anthropic-oauth.test.ts`; consumer: `pi-anthropic-auth/test/anthropic-oauth.test.ts` | Upstream supplies the same subscription flow and the consumer tests pass. |
| Fork-aware updates | Avoid replacing this Git checkout with a registry installation. Verify a published release, then prepare an isolated merge candidate for review. Used by `pi update`. | coding-agent: `fork-update-release.test.ts`, `fork-self-update.test.ts`, `package-command-paths.test.ts` | Upstream supports the same release verification and preparation/approval boundary for local forks. |

## Preparing an update

1. Start with clean `main`, including index and untracked files. `pi update` (or `pi update --self`) detects the linked fork and verifies GitHub's **latest published stable release**, not the latest tag or `upstream/main`.
2. Verification accepts GitHub HTTPS/SSH upstream URLs and uses GitHub's API, without requiring `gh`. It checks publication metadata, semantic version, the advertised tag and peeled commit, fetches only that tag without replacing local tags, and rechecks its identity. An already integrated release is a no-op; inconsistent versions, offline mode, network/rate-limit failures and moved tags block preparation. `--force` cannot bypass these checks.
3. The nested agent receives the exact release and starting main SHA. It creates a uniquely named branch/worktree from **our main SHA**, outside the canonical repositories, then runs `git merge --no-ff --no-commit <verified-release-sha>`. It must not use rebase, whole-side conflict choices or the `ours` merge strategy to hide conflicts.
4. Reconcile every inventory item with upstream APIs. Hydrate dependencies using `npm ci --ignore-scripts`. Use official model generators when necessary; review generated changes and dependency/lockfile changes. Do not run lifecycle scripts automatically.
5. Run `npm run check` and focused regressions with isolated HOME, no inherited provider credentials/endpoints and `PI_OFFLINE=1`. Validate isolated extension copies against **candidate sources**, not installed dist files. Use temporary TypeScript paths and Vitest aliases derived from the candidate's root configurations; do not relink active consumers. If combining source projects introduces incompatible ambient declarations (for example, Node/DOM or highlight.js versions), first check the fork sources with their own configuration, emit declaration-only files into a temporary directory, then typecheck consumers against those fresh declarations. Runtime tests must still resolve candidate sources. This emits no JavaScript and uses no installed dist files; runtime build validation requires separate approval.
6. Review the entire working tree diff against the verified release (staged, unstaged and untracked). Every difference must be an inventory behavior, a required adaptation or reviewed generated output. Update the upstream base above in the candidate.
7. Report base SHA, release URL/version/tag/commit, branch/path, pending merge/conflicts, checks and consumer compatibility. Confirm the original main has not advanced and its checkout is unchanged. Keep incomplete candidates and diagnostics; never silently discard another run's work.

`candidate validated; activation pending` means all required checks passed. `candidate incomplete` means a blocker or missing validation remains. A zero exit status from the nested agent only means its process completed, not that validation or installation succeeded.

Preparation does **not** commit, push, activate or relink. `--all` still explicitly updates installed packages separately; that package-manager operation is not isolated by the fork candidate. `PI_DISABLE_FORK_UPDATE_AGENT=1` explicitly opts out to the normal package-manager path; verification failures never fall back to it implicitly.

## Approval and promotion checklist

These are separate authorized actions, not part of `pi update` preparation:

- Review the candidate diff and validation report; approve any replacement/removal of intentional behavior.
- Verify the original main still equals the pinned base. If it advanced, stop and prepare/revalidate from the new base rather than forcing promotion.
- Complete one merge commit with the old main as first parent and the verified release as second parent. Include the release URL, tag and full SHA in its message. Stage explicit paths only and run checks before committing.
- Advance main with `git merge --ff-only <candidate-branch>`; publish with a normal push only when requested.
- Build and activate only with approval, then verify the installed version, extension loading and the relevant interactive behavior. Preserve a recovery bundle/snapshot until activation is checked.
- Remove only this run's temporary worktree and branch after their work is safely integrated. Keep the two canonical repository paths stable.

The one-time history reconstruction candidate is different: its six commits reproduce the old snapshot but intentionally exclude duplicated historical ancestry. Do not merge the old main into that candidate or promote it through the normal fast-forward checklist. Replacing its already-published history requires a separate approved procedure; this document does not authorize it.
