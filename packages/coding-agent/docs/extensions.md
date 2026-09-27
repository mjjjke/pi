# Extensions

Extensions are TypeScript modules that add executable behavior to Pi. Use one when a workflow needs tools, commands, event handlers, model providers, session state, or terminal UI rather than instructions alone.

An extension runs inside the Pi process with the same operating-system permissions. It can inspect prompts, tool calls, files, credentials, and session history, so load extensions only from sources you trust.

Typical extensions add an agent tool, protect paths, confirm dangerous commands, react to session events, modify context, expose a command, or display persistent status.

<a id="quick-start"></a>
<a id="writing-an-extension"></a>
<a id="create-an-extension"></a>

## Create and load an extension

An extension exports a default factory that receives `ExtensionAPI`. The factory registers capabilities for the current extension runtime.

Create `~/.pi/agent/extensions/hello.ts`:

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("hello", {
    description: "Show a greeting",
    handler: async (name, ctx) => {
      ctx.ui.notify(`Hello, ${name || "world"}!`, "info");
    },
  });
}
```

Start Pi and run `/hello`. During development, load a file directly:

```bash
pi --extension ./hello.ts
```

Pi uses `jiti`, so local TypeScript extensions do not need a separate compilation step. Use [Pi packages](packages.md) for distributed extensions and dependencies.

<a id="extension-locations"></a>
<a id="available-imports"></a>
<a id="choose-where-it-loads"></a>

## Add it to Pi

Place the extension in your user or project extensions directory. Pi loads direct TypeScript or JavaScript files and subdirectories containing an `index.ts` or `index.js` entry point.

Use a single file for a small extension and a directory for a multi-file implementation. Put npm dependencies in a nearby `package.json`. See [Configuration](configuration.md) for conventional locations and [Settings](settings.md#resources) for additional paths.

Reload replaces the extension runtime, so code after `await ctx.reload()` must not reuse state from the old runtime. Only personal and explicit command-line extensions can participate in the `project_trust` event that runs before project extensions load.

<a id="understand-the-lifecycle"></a>

## Respect the runtime lifecycle

The factory can be synchronous or asynchronous. Pi waits for an asynchronous factory before startup continues, allowing it to fetch configuration or register providers needed during startup.

Do not start processes, sockets, watchers, or timers in the factory because some invocations load extensions without starting a session.
Start long-lived resources from `session_start` or from the command or tool that needs them.
Close session-scoped resources from an idempotent `session_shutdown` handler.

A run proceeds from input and `before_agent_start`, through model, message, and tool events, to `agent_end`.
Automatic retries, recovery, compaction, or queued work can continue afterward.
<a id="agent_start--agent_end--agent_before_settle--agent_settled"></a>

`agent_before_settle` is the final actionable boundary: it can append entries and request one continuation.
`agent_settled` is final and notification-only; use it when an integration needs to know Pi will not continue automatically.

<a id="extensionapi-methods"></a>

## Choose an integration point

| Capability | Main API |
|---|---|
| Observe or modify lifecycle behavior | `pi.on()` |
| Add a model-callable operation | `pi.registerTool()` |
| Add a `/` command | `pi.registerCommand()` |
| Add a shortcut or CLI flag | `pi.registerShortcut()` or `pi.registerFlag()` |
| Send user or custom messages | `pi.sendUserMessage()` or `pi.sendMessage()` |
| Persist non-context session data | `pi.appendEntry()` |
| Change active tools, model, or thinking level | Session control methods on `pi` |
| Add a model provider | `pi.registerProvider()` |
| Add terminal rendering | Renderer registration, `pi.registerToolRenderer()`, and `ctx.ui` |
| Communicate with another extension | `pi.events` |

Use the exported declarations in [`extensions/types.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/extensions/types.ts) for exact event, context, tool, and result types.

## Follow the extension contracts

<a id="events"></a>
<a id="work-with-events"></a>

### Events and concurrency

Handlers run in extension load and registration order. `pi.on()` returns a function that unsubscribes that registration; changes do not affect a dispatch already in progress.
Some events notify; others transform data, replace results, or cancel an operation.
Use each event’s declared result type rather than assuming every return value has an effect.

Events cover resource discovery, sessions, agent and message lifecycle, providers, tools, and raw input.

`before_agent_start` exposes both the current prompt and its structured `systemPromptOptions`. Prefer changing prompt sections, selected tools, or guidelines so Pi can append a transcript delta. Returning `systemPrompt`, or setting `forceSystemPrompt`, replaces the whole prompt for that run while the transcript continues recording the structured sections. Providers receive the forced text as their leading system prompt.

`message_end` can replace a finalized message while preserving its role. `tool_call` can mutate input or block execution. `tool_result` handlers compose, with each handler seeing prior changes.

<a id="context_with_system"></a>

`context` transforms conversation messages without prompt and tool system messages; Pi restores that state afterward. Use `context_with_system` only when a request-local transformation must own the complete transcript, and keep a system message at index zero.

This fork also supports text-only, first-class developer instructions from `context`:

```typescript
import { supportsMidConversationInstructionMessages } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("context", (event, ctx) => {
    if (!ctx.model || !supportsMidConversationInstructionMessages(ctx.model)) return;
    return {
      messages: [
        ...event.messages,
        { role: "developer", content: "Prefer minimal, reversible changes.", timestamp: Date.now() },
      ],
    };
  });
}
```

Unsupported developer instructions are dropped during provider serialization rather than failing the request. System messages retain upstream prompt/tool replay semantics. Custom models opt in through `capabilities.midConversationInstructionMessages`; keep provider wire-format quirks in `compat`. Anthropic serializes supported developer instructions as `system` messages in a valid position; OpenAI uses `developer`, or `system` when developer-role support is absent.

Prefer first-class instruction messages over rewriting provider payloads in `before_provider_request`. Reserve that hook for serialization debugging, cache behavior, or experiments not expressible in Pi's message model. Payload-level changes are not reflected by `ctx.getSystemPrompt()`.

`turn_end` and `agent_before_settle` are actionable boundaries. Their handlers can chain proposed `custom`, `custom_message`, `context_edit`, or `compaction` entries and return `continue: true` for one next model request. Guard continuation conditions because an unconditional continuation can loop. Use the exported event declarations for the complete validation and ordering contract.

<a id="cache_warming_decision"></a>

`cache_warming_decision` can override an idle prompt-cache refresh with `{ action: "warm" }` or `{ action: "stop" }`. The last handler that returns an action wins.

Tool calls from one assistant message can run in parallel.
Do not assume a sibling call or result exists when another tool event runs.
Use `ctx.signal` for nested work owned by an active turn; commands and idle session events often have no operation signal.

A `user_bash` handler that returns `undefined` passes the command to the next handler and then to local execution if no handler handles it. Returning `operations` or `result` stops propagation. A handler failure blocks the command rather than falling through to local execution.

<a id="custom-tools"></a>
<a id="register-tools"></a>

### Tools

A custom tool defines a name, model-facing description, TypeBox parameter schema, and `execute()` function.
Its result requires model-facing `content` and a `details` field for rendering or state reconstruction.
Use `details: undefined` when there are no structured details. If the tool makes nested model calls, include their `usage` in the result so session totals remain accurate.

Throw from `execute()` to produce a failed tool result.
Returning an object does not mark it as an error.
Return `terminate: true` only when the agent should skip its automatic follow-up after every completed tool in that batch agrees to terminate.

Use sequential execution when tools share mutable in-memory state.
File-mutating tools should wrap the complete read-modify-write operation with `withFileMutationQueue()`.
Truncate large model-facing results and tell the model where to read the complete output.

See [`hello.ts`](../examples/extensions/hello.ts), [`todo.ts`](../examples/extensions/todo.ts), [`dynamic-tools.ts`](../examples/extensions/dynamic-tools.ts), and [`truncated-tool.ts`](../examples/extensions/truncated-tool.ts).

Registering a tool with an existing name replaces that tool's behavior; see [`tool-override.ts`](../examples/extensions/tool-override.ts). To change only how an existing tool is displayed, use [`pi.registerToolRenderer()`](#tool-renderer-decorators) instead. Re-registering a tool for rendering conflicts with extensions that own its behavior, because the first registration in load order wins.

### Activate tools dynamically

Register every tool first, keep optional tools inactive, and use `pi.setActiveTools()` from a loader tool to select the desired active tools. Names must already be registered; unknown names are ignored.

Pi records the initial prompt and tool set in the transcript's first system message, then appends tool and prompt changes before the next model request. Providers that cannot represent the transition receive a complete transcript checkpoint, which can invalidate the cached prefix.

<a id="extensioncontext"></a>
<a id="extensioncommandcontext"></a>
<a id="use-extension-context"></a>

### Context and session changes

`ExtensionContext` provides the working directory, mode, UI, session manager, model runtime, abort signal, context usage, and controls for compaction and shutdown.
Use `ctx.modelRegistry.streamSimple()` for provider-neutral nested model calls.

Command handlers receive `ExtensionCommandContext`, which adds operations for waiting until idle, reloading, tree navigation, and session replacement.
These operations are command-only because calling them from lifecycle handlers can deadlock the runtime.

Session replacement invalidates the old context. Capture only plain data before switching, then use the fresh context supplied to `withSession` for session-bound work. The fresh `ReplacedSessionContext` includes `appendDeveloperMessage()` and async `sendMessage()` and `sendUserMessage()` helpers.

### ctx.requestNewSession(options?)

This fork supports deferred session replacement from `agent_end` handlers only. Calls from other events, tools, commands, or shortcuts throw. Pi queues one replacement and runs it after the current `agent_end` emission finishes; another request for that emission returns `{ queued: false, reason: "already_pending" }`.

```typescript
pi.on("agent_end", async (_event, ctx) => {
  const request = await ctx.requestNewSession({
    parentSession: ctx.sessionManager.getSessionFile(),
    setup: async (sm) => {
      sm.appendCustomEntry("my-extension-state", { ready: true });
    },
    withSession: async (freshCtx) => {
      await freshCtx.sendMessage({
        customType: "my-handoff",
        content: "Handoff context",
        display: true,
      });
      await freshCtx.sendUserMessage("Continue from the handoff.", { deliverAs: "followUp" });
    },
  });

  if (!request.queued) {
    ctx.ui.notify("Another extension already requested a fresh session", "warning");
    return;
  }

  request.completion.then(
    (result) => {
      if (result.cancelled) {
        // Cancelled by session_before_switch.
      }
    },
    (error) => {
      // Replacement failed; handle or log the error.
    },
  );
});
```

Options match `ctx.newSession()`: `parentSession` records the parent file, `setup` mutates the new `SessionManager`, and `withSession` performs post-switch work against the fresh context. The old `pi` and `ctx` become stale after successful replacement.

`completion` resolves with `{ cancelled }`, or rejects when replacement fails, including unsupported modes. Attach a rejection handler when observing it. Never await `completion` inside the handler that queued it: replacement cannot run until all `agent_end` handlers return.

<a id="state-management"></a>
<a id="persist-state"></a>

### State

Choose storage based on how state participates in the conversation:

| State | Storage |
|---|---|
| Tool state that follows the active branch | Tool-result `details` |
| Durable data excluded from model context | `pi.appendEntry()` |
| Custom content stored and sent to the model | `pi.sendMessage()` |
| Data outside one session | External storage |

Reconstruct branch-sensitive state from `ctx.sessionManager.getBranch()` during `session_start`.
Do not rebuild it from every file entry because abandoned branches represent alternative histories.
Register an entry or message renderer when custom stored content should appear in the transcript.

### pi.appendDeveloperMessage(content)

Append a passive, persisted developer instruction without triggering a turn:

```typescript
pi.appendDeveloperMessage("Prefer concise, reversible changes.");
pi.appendDeveloperMessage([{ type: "text", text: "Stay in plan mode until approved." }]);
```

Blank content is ignored. Calls are allowed while idle and from `agent_end` handlers. Other active-run events, including `before_provider_request`, reject these calls; wait for idle when an interactive action occurs mid-stream. The canonical persisted role is `developer`; the wire role is resolved per provider as described above.

<a id="custom-ui"></a>
<a id="mode-behavior"></a>
<a id="interact-with-the-user"></a>
<a id="account-for-each-mode"></a>

### UI and modes

`ctx.ui` provides dialogs, notifications, status text, widgets, titles, editor access, and custom components.
Use `ctx.ui.custom()` only when the interaction needs its own rendering and input.
See [Terminal UI](tui.md) for component, focus, overlay, theme, and performance guidance.

Extensions load in interactive, RPC, JSON, and print modes.
Interactive mode provides the complete terminal UI.
RPC can forward supported dialogs and notifications through the [RPC Extension UI protocol](rpc-extension-ui.md), but not custom terminal components; JSON and print modes have no UI.
Guard terminal-only behavior with `ctx.mode === "tui"` and use `ctx.hasUI` for interactions supported by interactive and RPC clients.

Keep tool and event behavior independent from rendering so non-interactive modes remain functional.

### Assistant display transforms

This fork can change normal assistant text in the TUI without changing raw session or provider messages:

```typescript
pi.registerAssistantMessageDisplayTransform("my-extension", (message) => {
  return message.content.map((block) => {
    if (block.type !== "text") return block;
    return { ...block, text: block.text.replace("<submit_work/>", "Plan submitted") };
  });
});
```

Transforms run only in interactive rendering (`streaming`, `final`, and `restore` phases). They receive a frozen clone and run in extension load order, then registration order. Return `undefined` for no change, a string to replace aggregate text, a content array, or an assistant message. Only text blocks may change: Pi preserves thinking, tool calls, and metadata. JSONL, provider context, events, and session state remain unchanged.

See [assistant-display-transform.ts](../examples/extensions/assistant-display-transform.ts) for a boundary-marker example.

<a id="tool-renderer-decorators"></a>

### Tool renderer decorators

This fork can change how an existing tool (built-in or registered by any extension) renders in the TUI without re-registering it:

```typescript
import { Container, Text } from "@earendil-works/pi-tui";

pi.registerToolRenderer("bash", {
  renderCall(args, theme, context, base) {
    const container = new Container();
    container.addChild(new Text(theme.fg("muted", "shell"), 0, 0));
    const inner = base();
    if (inner) container.addChild(inner);
    return container;
  },
});
```

Decorators affect rendering only. The tool registry, `execute()`, tool declarations, and provider context are unchanged, so they do not affect the prompt cache and compose with extensions that override the tool's behavior.

- `renderCall` and `renderResult` receive the usual renderer arguments plus `base(theme?)`, which renders the next inner layer: another decorator or the tool's own renderer. Pass a theme to override it for inner layers. The inner layer renders at most once per invocation: repeat `base()` calls return the first result, or rethrow its error, and ignore their theme argument.
- Return a component to replace the output, or `undefined` to use the inner layer's component. When no layer and no tool renderer draws anything, Pi uses its default fallback rendering.
- Layers stack in extension load order, then registration order; the last registered decorator is the outermost. `renderShell` from the outermost decorator that defines it wins; otherwise the tool's value applies.
- `context.state` is private to each decorator for each tool row and shared by its `renderCall` and `renderResult`. It starts as an empty object; type it with the third type parameter, for example `pi.registerToolRenderer<BashToolInput, BashToolDetails, { renders: number }>("bash", ...)`. `context.lastComponent` is the component that decorator itself last returned. The tool's own renderer keeps its own state and component, so wrapping it is safe.
- Skipping `base()` means the inner renderer does not run for that render. Most built-in renderers are stateless, so deciding per render is fine (for example, calling `base()` only when expanded). Renderers that keep timers across renders need care: built-in `bash` starts an elapsed-time timer in `renderResult` while output is partial and stops it in the final `renderResult`. If a `bash` result decorator calls `base()` for partial results, it must also call it for the final result.
- If a decorator throws, Pi bypasses it for the rest of that tool row and slot. It reports a `tool_renderer` extension error once per extension, tool, and slot until the next reload, so rebuilding history does not repeat the same error for every row. Errors from the tool's own renderer behave as without decorators.
- The `theme` argument is the live theme: it follows theme switches and exposes `sourcePath` and `getColorMode()`. Derive colors from it on each render and do not cache by theme identity.

Decorators apply only to tools with a definition (built-in or registered); unknown tools keep the generic rendering. They are not applied to HTML session exports. Each tool row captures the decorators present when the row is created. Register decorators in the extension factory so rows rebuilt from history after `/reload` include them; registrations from `session_start` can miss that rebuilt history.

See [built-in-tool-renderer.ts](../examples/extensions/built-in-tool-renderer.ts) for compact rendering of `read`, `bash`, `edit`, and `write`.

<a id="error-handling"></a>
<a id="handle-errors-and-shutdown"></a>

### Errors and cleanup

Pi reports handler errors and continues where possible. A `tool_call` handler failure blocks the tool as a fail-safe; a tool execution failure becomes an error result for the model.

Release resources in `session_shutdown` even when normal operation attempted cleanup.
Keep cleanup idempotent because cancellation, reload, session replacement, and process exit can converge on the same path.
Use `ctx.shutdown()` to request an orderly process shutdown.

<a id="examples-reference"></a>
<a id="use-examples-as-the-implementation-reference"></a>

## Examples and reference

The checked [extension examples](../examples/extensions/) cover tools, lifecycle events, commands, flags, shortcuts, state, rendering, providers, OAuth, remote execution, and terminal components.
Start with the smallest example matching your integration point.

Use [Custom Providers](custom-provider.md) for model-service integrations, [Terminal UI](tui.md) for custom components, and [Pi Packages](packages.md) to install or distribute extensions with other resources.
