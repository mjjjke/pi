# Session File Format

Sessions are stored as JSONL (JSON Lines) files. Each line is a JSON object with a `type` field. Session entries form a tree structure via `id`/`parentId` fields, enabling in-place branching without creating new files.

For programmatic creation, persistence, and tree navigation, see the [`SessionManager` API](sdk.md#sessionmanager-api).


## File Location

```
~/.pi/agent/sessions/--<path>--/<timestamp>_<session-id>.jsonl
```

By default, `<session-id>` is a UUID. Callers can supply a custom ID through the SDK or `--session-id`. For `<path>`, Pi removes the leading path separator and replaces `/`, `\\`, and `:` with `-`.

## Deleting Sessions

Sessions can be removed by deleting their `.jsonl` files under `~/.pi/agent/sessions/`.

Pi also supports deleting sessions interactively from `/resume` (select a session and press `Ctrl+D`, then confirm). When available, pi uses the `trash` CLI to avoid permanent deletion.

## Session Version

Sessions have a version field in the header:

- **Version 1**: Linear entry sequence (legacy, auto-migrated on load)
- **Version 2**: Tree structure with `id`/`parentId` linking
- **Version 3**: Renamed `hookMessage` role to `custom` (extensions unification)
- **Version 4** (this fork): canonical startup prefix. The initial system snapshot is the first context entry of every branch, followed by developer instructions, then content. Every compaction has a `systemMessage` checkpoint. Adds the `standing_instruction` entry, `SessionMessageEntry.standingKey`, `CompactionEntry.standing` and `BranchSummaryEntry.systemMessage`.

Versions 1 and 2 are migrated on load as before. Version 3 files are migrated to v4 once, by a batch command, while no pi process runs (below).

### Migrating to v4

```bash
pi sessions migrate --dry-run --dir ~/.pi/agent/subagent-sessions   # report only
pi sessions migrate --dir ~/.pi/agent/subagent-sessions
```

`pi sessions migrate [--dry-run] [--dir <path>]...` walks every `*.jsonl` below its roots (deduplicated by real path): `<agentDir>/sessions`, the `sessionDir` setting (global settings only; pass a project-level `sessionDir` with `--dir`), `PI_CODING_AGENT_SESSION_DIR`, and every `--dir`. Files without a session header are reported `invalid` and left untouched; v4 files are `current`; v3 and older files are migrated and rewritten atomically (temp file in the same directory, `fsync`, `rename`), keeping the file's permission bits, owner and group when possible, and its mtime (so the session `pi -c` resumes does not change). An older file with a line that does not parse as JSON is never rewritten (a rewrite would drop those bytes): it is reported as `refused` with its line numbers and left byte-identical; fix or remove the line and run again. An I/O error leaves the original untouched and counts as `failed`. The report lists the roots with their source, scanned, current, migrated (prefixes permuted, `firstKeptEntryId` remapped, checkpoints backfilled, header-only bumps), skipped with reason and path, refused, invalid and failed. A second run reports `migrated 0`.

The migration of one file:

1. **Startup prefix.** For each system entry that is the first system message on its path, the context entries before it and the system entry itself are reordered within their own file positions: system first, then developers, then content, each in the old order. Non-context entries (model and thinking changes, custom state, labels) keep their positions; parent ids are recomputed along the chain; entry ids never change. It skips (and warns once per file) a prefix that contains an assistant, tool result, compaction or branch summary, a branch inside the prefix, and a system entry that is the file's last entry. A skipped file is still bumped to v4 and stays noncanonical.
2. **Compaction targets.** A `firstKeptEntryId` that points to any entry of a reordered block (context or not) moves to the block's first context entry, which keeps a superset of the old range.
3. **Checkpoints.** A compaction without `systemMessage` gets the replayed system state of its path.

Exit codes: 0 done, 1 usage error, a failed file or a refused file, 2 refused because pi is running. Before writing, the command lists other live pi processes (Linux: `/proc/<pid>/comm` is `pi` or `pi-rpc` and the executable is node or bun; elsewhere `ps`), including a parent pi, so running it from a pi bash tool is refused. If any is live and at least one file to rewrite lies inside `<agentDir>` or inside the `sessionDir` / `PI_CODING_AGENT_SESSION_DIR` roots, it prints the pids and exits 2 without writing. A file reached through one of those stores counts as inside it even when a directory or file symlink points elsewhere. Files only under other `--dir` roots produce a warning. `--dry-run` never refuses. The probe does not detect SDK hosts named `node` or renamed binaries; confirm with `pgrep -ax 'pi|pi-rpc'`.

**Stray v3 files.** A v3 file opened later (written by an older build, copied in, or outside the migrated roots) is migrated in memory and rewritten atomically: temp file, `fsync`, a re-check that size and mtime still match the revision that was read, then `rename` (permissions and mtime kept). Opening never writes anything else. If the file has a line that does not parse, the re-check differs or anything fails, the file stays untouched, the session uses the migrated view in memory (the raw entries if migrating threw) and Pi prints a warning (at startup, and after `/resume`, fork and import). Leftover temp files are deleted on the next attempt. Another process that appends to the same file between the re-check and the rename loses that append; two pi processes writing one session file are unsupported anyway.

`forkFrom` (CLI `--fork`) migrates the copied source entries in memory and publishes the fork atomically; the source file is never rewritten.

Older builds still open v4 files: they ignore the new entry type and fields, so after a rollback a compaction's carried standing values are missing, hidden keyed developers show again, and a branch-summary checkpoint is not projected.

### Write failures

The first write of a new session file and every whole-file write (migration rewrites, branched-session files, forks) go through a temp file in the same directory (`.<name>.<pid>.tmp`), `fsync`, and a hard link (new files) or `rename` (rewrites), so a failure leaves no visible partial file and can be retried. If appending an entry fails, the entry is removed from memory and the leaf restored. Because some bytes may have reached the file, the manager records a sticky persistence error (`getPersistenceError()`): later appends throw at once, and `AgentSession` refuses to start runs or send requests with `Session file write failed (<code>): the last entry may be missing or partial. Resume the session (/resume, or restart with pi -c) to continue.` Reopening the file clears it: the loader skips malformed lines without writing, and the first append after opening a file that does not end with a newline writes one first, so a fragment never merges with the next entry.

## Source Files

Source on GitHub ([pi](https://github.com/earendil-works/pi)):
- [`packages/coding-agent/src/core/session-manager.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/session-manager.ts) - Session entry types and SessionManager
- [Message Types](message-types.md) - Shared message and content-block reference
- [`packages/coding-agent/src/core/messages.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/messages.ts) - Extended message types
- [`packages/ai/src/types.ts`](https://github.com/earendil-works/pi/blob/main/packages/ai/src/types.ts) - Base message and content-block types
- [`packages/agent/src/types.ts`](https://github.com/earendil-works/pi/blob/main/packages/agent/src/types.ts) - Extensible `AgentMessage` union

For TypeScript definitions in your project, inspect `node_modules/@earendil-works/pi-coding-agent/dist/` and `node_modules/@earendil-works/pi-ai/dist/`.

## Messages

A `message` entry stores an [`AgentMessage`](message-types.md). Message content blocks, roles, usage, and message timestamps are defined in [Message Types](message-types.md).

Session entry timestamps are ISO 8601 strings. The nested message timestamp is a Unix timestamp in milliseconds.

## Entry Base

All entries (except `SessionHeader`) extend `SessionEntryBase`:

```typescript
interface SessionEntryBase {
  type: string;
  id: string;           // Usually an 8-char hex ID; may fall back to a full UUID
  parentId: string | null;  // Parent entry ID (null for a root entry)
  timestamp: string;    // ISO timestamp
}
```

## Entry Types

### SessionHeader

First line of the file. Metadata only, not part of the tree (no `id`/`parentId`).

```json
{"type":"session","version":4,"id":"uuid","timestamp":"2024-12-03T14:00:00.000Z","cwd":"/path/to/project"}
```

For sessions with a parent (created via `/fork`, `/clone`, or `newSession({ parentSession })`):

```json
{"type":"session","version":4,"id":"uuid","timestamp":"2024-12-03T14:00:00.000Z","cwd":"/path/to/project","parentSession":"/path/to/original/session.jsonl"}
```

### SessionMessageEntry

A message in the conversation. The `message` field contains an `AgentMessage`. System messages carry the prompt and tool loadout: the first request of a session persists one with every prompt section and tool declaration, and later changes persist as system messages that patch `sections` by name (`null` removes one) and list `toolsAdded`/`toolsRemoved`. Replaying them in order yields the current prompt and tools; there is no separate prompt state entry.

```json
{"type":"message","id":"a0b1c2d3","parentId":null,"timestamp":"2024-12-03T14:00:00.000Z","message":{"role":"system","content":"","sections":{"preamble":"You are an expert coding assistant...","tools":"<tools>\n- read: ...\n</tools>","cwd":"/project"},"toolsAdded":[{"name":"read","description":"...","parameters":{}}],"timestamp":1733234400000}}
{"type":"message","id":"d4e5f6g7","parentId":"c3d4e5f6","timestamp":"2024-12-03T14:04:00.000Z","message":{"role":"system","content":"","sections":{"skills":"<skills>...</skills>"},"toolsRemoved":[{"name":"write"}],"timestamp":1733234640000}}
```

In v4 the first system message is the first context entry of every branch: the first run of a branch writes it before any staged developer instruction or content (see [Extensions: before the first run](extensions.md#before-the-first-run)). Providers treat only the message at index 0 as the initial snapshot; any later system message is an update. Sessions created before system messages existed have no leading system message; the first request declares the current prompt as a later system message, which replays the same way.

```json
{"type":"message","id":"a1b2c3d4","parentId":"prev1234","timestamp":"2024-12-03T14:00:01.000Z","message":{"role":"user","content":"Hello","timestamp":1733234401000}}
{"type":"message","id":"b2c3d4e5","parentId":"a1b2c3d4","timestamp":"2024-12-03T14:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Hi!"}],"api":"anthropic-messages","provider":"anthropic","model":"claude-sonnet-4-5","usage":{...},"stopReason":"stop","timestamp":1733234402000}}
{"type":"message","id":"c3d4e5f6","parentId":"b2c3d4e5","timestamp":"2024-12-03T14:00:03.000Z","message":{"role":"toolResult","toolCallId":"call_123","toolName":"bash","content":[{"type":"text","text":"output"}],"isError":false,"timestamp":1733234403000}}
```

Assistant messages name the model that produced them. Newer messages also record `thinkingLevel`, the Pi thinking level requested for that response.

This fork also persists text-only developer instructions as ordinary message entries:

```json
{"type":"message","id":"dev12345","parentId":"c3d4e5f6","timestamp":"2024-12-03T14:00:04.000Z","message":{"role":"developer","content":"Prefer concise answers.","timestamp":1733234404000}}
```

Extensions can inject developer instructions ephemerally through `context`, or persist them without starting a turn through `pi.appendDeveloperMessage()`. Unsupported developer messages are dropped during provider serialization; system messages retain their prompt/tool replay semantics. See [DeveloperMessage](message-types.md#developermessage) for the shared type.

A developer message that delivers a [standing instruction](#standing-instructions) has `standingKey` on the entry (not on the message):

```json
{"type":"message","id":"dev23456","parentId":"a1b2c3d4","timestamp":"2024-12-03T14:00:05.000Z","standingKey":"collaboration-mode","message":{"role":"developer","content":"<collaboration_mode>...</collaboration_mode>","timestamp":1733234405000}}
```

### ModelChangeEntry

Emitted when the user switches models mid-session. The latest entry is the selected model, which may be a [virtual model](virtual-models.md); assistant messages then name the physical model that answered.

```json
{"type":"model_change","id":"d4e5f6g7","parentId":"c3d4e5f6","timestamp":"2024-12-03T14:05:00.000Z","provider":"openai","modelId":"gpt-4o"}
```

### ThinkingLevelChangeEntry

Emitted when the user changes the thinking/reasoning level.

```json
{"type":"thinking_level_change","id":"e5f6g7h8","parentId":"d4e5f6g7","timestamp":"2024-12-03T14:06:00.000Z","thinkingLevel":"high"}
```

### UsageEntry

Records model-attributed usage that is not an assistant message and does not participate in LLM context. `kind` is an arbitrary string identifying the operation; for example, cache warming uses `"cache_warm"`.

```json
{"type":"usage","id":"f6g7h8i9","parentId":"e5f6g7h8","timestamp":"2024-12-03T14:08:00.000Z","kind":"cache_warm","provider":"anthropic","model":"claude-sonnet-4-5","usage":{"input":0,"output":0,"cacheRead":50000,"cacheWrite":0,"totalTokens":50000,"cost":{"input":0,"output":0,"cacheRead":0.015,"cacheWrite":0,"total":0.015}}}
```

Usage entries contribute to session token and cost totals. Pi hides them from the conversation tree. Consumers should treat unknown `kind` values as normal usage rather than rejecting them.

### CompactionEntry

Created when context is compacted. Stores a summary of earlier messages and a complete system prompt/tool checkpoint.

```json
{"type":"compaction","id":"f6g7h8i9","parentId":"e5f6g7h8","timestamp":"2024-12-03T14:10:00.000Z","summary":"User discussed X, Y, Z...","firstKeptEntryId":"c3d4e5f6","tokensBefore":50000,"systemMessage":{"role":"system","content":"You are a coding assistant.","toolsAdded":[],"timestamp":1733235000000}}
```

`firstKeptEntryId` is required. It identifies the first entry retained from before the compaction entry. When rebuilding context, Pi replaces older summarized entries with the compaction summary and keeps the range beginning at this entry. A retain-none compaction stores its own ID in this field, so no preceding entries are retained.

Optional fields:
- `systemMessage`: The replayed prompt sections and tool declarations at the compaction boundary; it becomes the leading system message of the compacted context, and system messages among the kept entries are dropped in its favor. Written by every compaction; the v4 migration backfills it on older entries.
- `standing`: `Array<{ key, message: DeveloperMessage }>`, the [standing values](#standing-instructions) carried into the new epoch, in key order, with the compaction's timestamp. Present (possibly `[]`) on every compaction written by this fork; its presence makes the compaction standing-aware. Never backfilled.
- `usage`: LLM usage from generating the summary; included in session token and cost totals
- `details`: Implementation-specific data (e.g., `{ readFiles: string[], modifiedFiles: string[] }` for default, or custom data for extensions)
- `fromHook`: `true` if generated by an extension, `false`/`undefined` if pi-generated (legacy field name)

### ContextEditEntry

Append-only edit of one earlier context-producing entry. It changes only future model context; the target entry and its metadata remain unchanged in raw history, UI, exports, and session accounting.

```json
{"type":"context_edit","id":"g6h7i8j9","parentId":"f6g7h8i9","timestamp":"2024-12-03T14:11:00.000Z","targetId":"c3d4e5f6","replacement":null}
```

Targets may be user, assistant, tool-result, or custom-message entries. `replacement: null` omits the target from model context. A non-null `replacement` replaces only the target message content. String replacements for assistant and tool-result entries are normalized to one text block because those roles require content arrays. If several edits target the same entry, the latest edit on the active branch wins. Edits are branch-relative: navigating to a point before the edit reveals the target's original contribution again.

### BranchSummaryEntry

Created when switching branches via `/tree` with an LLM generated summary of the left branch up to the common ancestor. Captures context from the abandoned path.

```json
{"type":"branch_summary","id":"g7h8i9j0","parentId":"a1b2c3d4","timestamp":"2024-12-03T14:15:00.000Z","fromId":"f6g7h8i9","summary":"Branch explored approach A..."}
```

`parentId` is the entry from which the new branch continues. `fromId` is the previous leaf whose abandoned path was summarized.

Optional fields:
- `systemMessage` (this fork): a checkpoint of the source branch's replayed system state, written only when the target path has no system message (for example a summary at the root). It is projected before the summary only when no compaction precedes the summary; in a compaction's kept range only the summary text is projected.
- `usage`: LLM usage from generating the summary; included in session token and cost totals
- `details`: File tracking data (`{ readFiles: string[], modifiedFiles: string[] }`) for default, or custom data for extensions
- `fromHook`: `true` if generated by an extension, `false`/`undefined` if pi-generated (legacy field name)

### CustomEntry

Extension state persistence. Does NOT participate in LLM context.

```json
{"type":"custom","id":"h8i9j0k1","parentId":"g7h8i9j0","timestamp":"2024-12-03T14:20:00.000Z","customType":"my-extension","data":{"count":42}}
```

Use `customType` to identify your extension's entries on reload. Interactive mode can render custom entries via `pi.registerEntryRenderer(customType, renderer)`, but they still do not participate in LLM context.

Pi stores [virtual model](virtual-models.md) router state as custom entries with `customType` `pi.virtual-model-state` and `data` `{ provider, modelId, state }`.

### CustomMessageEntry

Extension-injected messages that DO participate in LLM context.

```json
{"type":"custom_message","id":"i9j0k1l2","parentId":"h8i9j0k1","timestamp":"2024-12-03T14:25:00.000Z","customType":"my-extension","content":"Injected context...","display":true}
```

Fields:
- `content`: String or `(TextContent | ImageContent)[]` (same as UserMessage)
- `display`: `true` = show in TUI with distinct styling, `false` = hidden
- `details`: Optional extension-specific metadata (not sent to LLM)

<a id="standing-instructions"></a>

### StandingInstructionEntry

This fork's desired value of a standing instruction (see [Extensions: standing instructions](extensions.md#standing-instructions)). Non-context: it projects nothing. The tree shows it as `[standing: <key>]`.

```json
{"type":"standing_instruction","id":"l1m2n3o4","parentId":"k1l2m3n4","timestamp":"2024-12-03T14:36:00.000Z","key":"collaboration-mode","content":"<collaboration_mode>...</collaboration_mode>","apply":"next-request"}
```

- `content`: string or `TextContent[]`; absent means the key was cleared.
- `apply`: `"next-input"` or `"next-request"`; absent means `"next-input"`.

State is derived from the active branch (`getStandingState()`, root to leaf) and never cached:

- **Desired:** the latest state entry for the key (cleared: none). A key with no state entry on the branch takes the latest keyed value (keyed developer or carried item) instead; this covers legacy messages tagged with `standingKey` after the fact.
- **Delivered:** a keyed developer sets it. A standing-aware compaction resets every key to its `standing` items (absent key: none). An older compaction (no `standing` field) resets every key to the latest keyed developer its kept range retains, or none.
- **Pending:** a desired value whose content differs from the delivered content (canonical JSON comparison).
- **Key order:** first appearance of the key on the branch. Bootstrap, request-boundary delivery and the compaction carry use it.

### LabelEntry

User-defined bookmark/marker on an entry.

```json
{"type":"label","id":"j0k1l2m3","parentId":"i9j0k1l2","timestamp":"2024-12-03T14:30:00.000Z","targetId":"a1b2c3d4","label":"checkpoint-1"}
```

Set `label` to `undefined` to clear a label.

### SessionInfoEntry

Session metadata (e.g., user-defined display name). Set via `/name`, `--name` / `-n`, or `pi.setSessionName()` in extensions.

```json
{"type":"session_info","id":"k1l2m3n4","parentId":"j0k1l2m3","timestamp":"2024-12-03T14:35:00.000Z","name":"Refactor auth module"}
```

The session name is displayed in the session selector (`/resume`) instead of the first message when set.

## Tree Structure

Entries normally form one tree, but navigation APIs can create multiple roots:
- A root entry has `parentId: null`; the first entry is initially the root
- Each non-root entry points to its parent via `parentId`
- Branching creates new children from an earlier entry
- The "leaf" is the current position in the tree
- Calling `resetLeaf()` or `branchWithSummary(null, ...)` allows a later entry to become another root

```
[user msg] ─── [assistant] ─── [user msg] ─── [assistant] ─┬─ [user msg] ← current leaf
                                                            │
                                                            └─ [branch_summary] ─── [user msg] ← alternate branch
```

## Context Building

`buildContextEntries()` walks from the current leaf to the root, producing the active entry list while honoring compaction:

1. Collects all entries on the path
2. If one or more `CompactionEntry` values are on the path, uses the latest one:
   - Includes the compaction entry first
   - Includes non-system entries from `firstKeptEntryId` up to, but not including, the compaction entry
   - Includes entries after the compaction entry
3. Preserves non-message entries in the selected range so interactive mode can render them

`buildSessionProjection()` then applies the latest `context_edit` for each selected target. It returns the model-visible messages together with their source entries. Omitted targets produce no message; replacements retain the source entry's role and metadata while changing only content. The raw selected entries are not modified.

`buildSessionContext()` builds on that projection to produce the message list for the LLM:

1. Extracts current model and thinking level settings from the full path
2. Converts selected entries to messages:
   - `message` -> stored `AgentMessage`
   - `compaction` -> complete system checkpoint, then the carried `standing` messages, then `compactionSummary`
   - `branch_summary` -> `branchSummary`, preceded by its `systemMessage` checkpoint when it has one and no compaction precedes it
   - `standing_instruction` -> no context message
   - `custom_message` -> `CustomMessage`
   - `context_edit` -> no context message of its own
   - `usage` and `custom` -> no context message

The compaction summary replaces entries before `firstKeptEntryId`. Pre-compaction system messages are folded into the complete checkpoint rather than replayed from the retained range. In the kept range of a standing-aware compaction, keyed developers (any `standingKey`) are also skipped, because the carried values replace them; they stay in the journal and in `getBranch()`. Unkeyed developers stay. Retained non-system entries and all entries after the compaction remain available to the LLM. A compacted context therefore starts like a new session: `checkpoint system · carried standing values · summary · kept entries · later entries`.

## Parsing Example

```typescript
import { readFileSync } from "fs";

const lines = readFileSync("session.jsonl", "utf8").trim().split("\n");

for (const line of lines) {
  const entry = JSON.parse(line);

  switch (entry.type) {
    case "session":
      console.log(`Session v${entry.version ?? 1}: ${entry.id}`);
      break;
    case "message":
      console.log(`[${entry.id}] ${entry.message.role}: ${JSON.stringify(entry.message.content)}`);
      break;
    case "compaction":
      console.log(`[${entry.id}] Compaction: ${entry.tokensBefore} tokens summarized`);
      break;
    case "branch_summary":
      console.log(`[${entry.id}] Branch from ${entry.fromId}`);
      break;
    case "usage":
      console.log(`[${entry.id}] Usage (${entry.kind}): ${entry.usage.totalTokens} tokens`);
      break;
    case "custom":
      console.log(`[${entry.id}] Custom (${entry.customType}): ${JSON.stringify(entry.data)}`);
      break;
    case "custom_message":
      console.log(`[${entry.id}] Extension message (${entry.customType}): ${entry.content}`);
      break;
    case "label":
      console.log(`[${entry.id}] Label "${entry.label}" on ${entry.targetId}`);
      break;
    case "model_change":
      console.log(`[${entry.id}] Model: ${entry.provider}/${entry.modelId}`);
      break;
    case "thinking_level_change":
      console.log(`[${entry.id}] Thinking: ${entry.thinkingLevel}`);
      break;
  }
}
```
