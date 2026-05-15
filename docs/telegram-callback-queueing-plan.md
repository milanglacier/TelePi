# Telegram callback queueing plan

## Goal

Identify the smallest safe architectural change that prevents Telegram callback expiry during long-running TelePi prompt flows, without rewriting the whole bot architecture yet.

This note is grounded in the current TelePi runtime:

- `src/bot.ts` owns grammY callback/message registration and directly awaits many long-running actions.
- `src/bot/prompt-handler.ts` owns the full prompt lifecycle and does not return until the Pi prompt finishes.
- `src/bot/chat-state.ts` exposes a single busy concept per chat/topic.
- `src/bot/extension-dialogs.ts` already separates callback acknowledgement text from post-answer work via `afterAnswer`.
- bare `/cron` is now a TelePi-native menu, but `cron_menu_*` callbacks still bridge into the same long-running prompt path.

## Current failure mode

### What happens today

Prompt-starting entrypoints currently stay inside the grammY update handler for the entire prompt lifetime:

- text messages -> `bot.on("message:text")` -> `await handleUserPrompt(...)`
- bridged Pi slash commands -> `await handleUserPrompt(...)`
- native `/cron` menu callbacks -> `await answerCallbackQuerySafely(...)` -> `await handleUserPrompt(...)`
- command picker Pi entries -> `await answerCallbackQuery(...)` -> `await handleUserPrompt(...)`
- voice follow-up after transcription -> `await handleUserPrompt(...)`

`handleUserPrompt` then:

1. marks the chat/topic as processing,
2. ensures a session exists,
3. binds extension UI,
4. subscribes to streaming/tool events,
5. awaits `piSession.prompt(...)`, and
6. only returns after final Telegram rendering is complete.

That means one Telegram update can remain "open" for the full lifetime of a prompt, including multi-step extension flows such as `/cron add`.

### Why callbacks still expire

TelePi already has some good local mitigations:

- extension dialog callbacks return `{ callbackText, afterAnswer }`, so TelePi *tries* to answer first and mutate Telegram state second;
- stale callback errors are now logged and suppressed via `src/bot/callback-query-logging.ts`;
- many non-dialog callbacks fail fast with `"Wait for the current prompt to finish"` while busy.

Those are useful, but they only help **after the callback update has reached its handler**.

The deeper issue is that TelePi currently couples **Telegram update processing** to **prompt execution lifetime**. If grammY/polling is effectively back-pressured by a still-running handler, later callback updates can sit in the ingress backlog long enough that Telegram considers them too old before `answerCallbackQuery` is even attempted.

That explains why the new native `/cron` menu reduced UX confusion but did not eliminate stale callbacks:

- the `/cron` button click itself is acknowledged quickly,
- but once it launches a long-running prompt/extension flow, later callback taps in that same flow can still arrive behind a long-running update.

## Important current behavior to preserve

Any fix should preserve these current semantics:

1. **One active prompt/session mutation per chat/topic** by default.
2. **Extension input replies stay allowed while a prompt is running.** This already works because `message:text` checks `extensionDialogs.consumeInput(...)` before the generic busy path.
3. **Extension callback resolution stays answer-first.** `resolveSelect/resolveConfirm/resolveCancel` returning `afterAnswer` is the right shape.
4. **Busy rejection remains explicit** for commands that should not queue behind an active prompt (`/sessions`, `/new`, `/model`, tree navigation, etc.).
5. **Forum topics stay isolated** by current `PiSessionContext` / context-key behavior.

## Options considered

### 1. Keep current architecture and add more stale-callback handling

Examples:

- wrap more callbacks in `answerCallbackQuerySafely`
- log more detail
- show better retry text when a callback is stale

**Verdict:** good mitigation, not a fix.

This improves observability and user messaging, but it does not change the ingress bottleneck. Callback expiry can still happen before TelePi sees the update.

### 2. Fire-and-forget every callback/message handler

Examples:

- stop awaiting everything in `src/bot.ts`
- let grammY handlers return immediately for all actions

**Verdict:** too risky as a blanket change.

TelePi still has shared mutable state in:

- `chatState`
- pending picker maps in `src/bot.ts`
- extension dialog state
- the underlying `PiSessionService`

Turning on broad fire-and-forget behavior without a small coordination layer would trade callback expiry for race conditions.

### 3. Enable global grammY parallelism first

Examples:

- add a runner/parallel update consumption before TelePi has per-context coordination

**Verdict:** not the first move.

Parallel ingress without a TelePi-side per-context gate would make session/picker/tree/model state races more likely. TelePi should own the concurrency policy first.

### 4. Recommended now: decouple prompt lifetime from update lifetime with a small per-context background runner

**Verdict:** smallest safe architectural change.

The change is:

- keep grammY handlers short-lived,
- answer callbacks immediately when applicable,
- start long-running prompt work in a TelePi-managed background task,
- keep busy semantics per chat/topic,
- do **not** introduce a full queue for all actions yet.

This addresses the suspected root cause directly while minimizing the blast radius.

## Recommended design

### Summary

Introduce a tiny per-context execution helper in `src/bot/` (name not important yet; examples below use `ChatTaskRunner`).

Its initial scope is narrow:

- only long-running **prompt-starting** flows move onto it;
- short control callbacks remain inline;
- non-prompt session mutations still use current busy rejection.

### What becomes detached

Use the runner for these paths only:

- free-form text prompts
- bridged Pi slash commands
- `/retry`
- native `/cron` menu callbacks once they dispatch to `/cron list|status|add|manage`
- command picker Pi commands
- voice transcription follow-up once transcription has completed

These all share the same property: they enter `handleUserPrompt`, which currently owns the full prompt lifetime.

### What stays inline for now

Keep these inline for this story:

- extension dialog callbacks (`ui_sel_*`, `ui_cfm_*`, `ui_x_*`)
- `pi_abort`
- session switching / new session callbacks
- model picker callbacks
- tree view/navigation callbacks
- pagination callbacks

Reason: these handlers are already relatively short or intentionally rejected while busy. They do not need a new queue yet.

### Expected control flow after the change

#### Text or slash command

1. grammY handler resolves `target`
2. TelePi checks current busy policy
3. TelePi synchronously acquires the context in the task runner
4. grammY handler starts background prompt work and returns immediately
5. background task runs the existing prompt lifecycle
6. background task releases the context on completion/failure

#### Callback that launches a prompt (`cron_menu_*`, command picker Pi entry)

1. grammY handler resolves `target`
2. callback is answered immediately
3. TelePi synchronously acquires the context in the task runner
4. background prompt work starts
5. callback handler returns immediately

That is the key change: **the callback update is no longer held open by the prompt it started**.

### Why this is enough for the immediate problem

Extension dialogs already have the right callback shape:

- resolve the semantic action,
- answer the callback,
- then run `afterAnswer`.

Once prompt execution is no longer monopolizing Telegram update handling, those dialog callbacks should be able to reach their handler in time.

This same change also improves responsiveness for:

- `pi_abort` during a running prompt,
- busy rejection callbacks/messages that currently may sit behind a long-running handler,
- any future native Telegram menus that ultimately bridge into `handleUserPrompt`.

## Minimal implementation shape

### 1. Add a tiny per-context runner

Suggested responsibilities:

- key by existing `getPiSessionContextKey(target)` behavior
- synchronously reserve/release a running slot
- expose a `startPromptTask(target, promptText, task)`-style API
- attach a required `.catch(...)` so detached failures are logged
- optionally keep a `Set<Promise>` for shutdown visibility later

Pseudo-shape:

```ts
interface ChatTaskRunner {
  tryStartPrompt(
    target: PiSessionContext,
    promptText: string,
    task: () => Promise<void>,
  ): "started" | "busy";
}
```

Important detail: reservation must happen **before** the handler returns, otherwise two quick updates could both observe the chat as idle.

### 2. Split prompt execution from prompt dispatch

Keep most of `src/bot/prompt-handler.ts` intact, but separate:

- **dispatch decision**: should this prompt start now?
- **prompt lifecycle execution**: the existing long-running body

A likely outcome:

- existing `createPromptHandler(...)` becomes a lower-level `runPromptFlow(...)`
- `src/bot.ts` (or a thin wrapper beside it) decides whether to call it inline or detached
- for this story, prompt flows should be detached

### 3. Move busy bookkeeping to the dispatch boundary

Today `beginProcessing(...)` happens inside `handleUserPrompt`.

After detaching work, TelePi should ensure the busy reservation is established synchronously before the handler returns. That can be done either by:

- letting the runner own `beginProcessing/endProcessing`, or
- keeping them in `chatState` but calling `beginProcessing` from the runner before scheduling the async task.

I would prefer the first option conceptually, but the second is the smaller code change.

### 4. Keep extension dialog mechanics unchanged

No architectural rewrite is needed in `src/bot/extension-dialogs.ts` for the immediate fix.

That file already expresses the right sequence:

- resolve dialog intent,
- provide user-visible callback text,
- finalize dialog message after callback acknowledgement.

The main problem is not the dialog manager itself; it is that callback updates may be delayed before reaching it.

## Immediate mitigations vs. the real fix

### Immediate mitigations (keep / complete now)

These are worth keeping, but they are not the core architectural answer:

- `answerCallbackQuerySafely` / stale-callback logging
- answer-before-edit ordering for extension dialogs
- fail-fast busy replies for non-dialog callbacks
- native `/cron` menu so bare `/cron` does not jump directly into a prompt

### Real fix for this story (do next)

**Decouple long-running prompt execution from grammY update lifetime via a TelePi-owned per-context background runner.**

That is the smallest change that directly attacks callback expiry during long prompt flows.

### Later, broader concurrency fix (not now)

If TelePi later needs true queued concurrency semantics, evolve the small runner into an explicit per-context controller with typed lanes.

Recommended eventual model:

- **control lane**: callback ack, dialog resolution, abort
- **session lane**: prompt, switch/new/model/tree navigation, other session mutations

And give each operation an explicit policy:

- reject-if-busy
- enqueue-after-current
- resume-active-prompt
- replace-stale-ui-state

That later design would unify busy handling and queueing, but it is more than this story needs.

## Recommendation on fire-and-forget vs queueing vs decoupling

### Prompt-starting actions

**Recommendation:** decouple them from the update handler and run them as TelePi-managed background tasks.

This is effectively a *controlled* fire-and-forget model, not a blind one.

### Callback handling in general

**Recommendation:** do not blindly queue every callback right now.

Most callbacks should still either:

- answer immediately and complete inline, or
- answer immediately and reject due to busy state.

### Long-term

**Recommendation:** if more interactive surfaces appear, move toward typed per-context queueing/lane control rather than ad hoc fire-and-forget.

## Risks

### 1. Detached errors no longer flow through the same grammY promise chain

If TelePi starts background tasks, every launch site must attach a catch/log path. Otherwise prompt failures can become silent.

### 2. Tests currently use `await bot.handleUpdate(...)` as a proxy for "prompt finished"

Those tests will need to change for detached prompt flows. Some assertions will need to wait on mocked prompt completion rather than handler completion.

### 3. Shutdown behavior becomes slightly less obvious

`bot.stop()` may stop ingress while detached prompt tasks are still running. For now this is acceptable if tasks just finish naturally, but it should be documented and optionally tracked.

### 4. Busy-state races if reservation is not synchronous

If the runner only marks busy after an `await`, two fast updates could both start. The runner must reserve synchronously.

### 5. Scope creep into non-prompt actions

If this change expands to switch/model/tree actions in the same patch, it will stop being the smallest safe change. Keep the first step narrow.

## Migration scope

### Files likely needed for the future implementation

- `src/bot.ts`
  - change prompt-launching handlers to dispatch background work instead of awaiting full prompt lifetime
- `src/bot/prompt-handler.ts`
  - split execution from dispatch, or expose a lower-level runner-friendly function
- `src/bot/chat-state.ts`
  - possibly no public API change, but busy bookkeeping may shift slightly
- `src/bot/<new-runner-file>.ts`
  - new small per-context background task helper
- `test/bot.test.ts`
  - update timing assumptions and add regressions around prompt detachment
- optional new focused unit test for the runner

### Files that should not need major changes for the immediate fix

- `src/pi-session.ts`
- `src/bot/extension-dialogs.ts`
- `src/bot/slash-command.ts`
- command rendering helpers

## Test strategy

### Unit tests

Add focused tests for the new runner:

- starts one prompt task per context
- rejects a second prompt start while the first is reserved
- releases the reservation on resolve
- releases the reservation on reject
- logs detached failures
- keeps different topic threads independent

### Integration tests in `test/bot.test.ts`

Add or update behavior tests for:

1. **native `/cron` callback detaches prompt work**
   - callback answer happens immediately
   - handler returns before the mocked prompt completes
2. **extension callback during long-running prompt remains processable**
   - start a prompt from a callback-launched path (for example `cron_menu_*`)
   - inside the mocked prompt, open a `select` or `confirm` dialog (or use an existing callback-driven extension command such as `/pick` or `/confirm`)
   - keep the prompt unresolved until the callback arrives
   - send `ui_sel_*` / `ui_cfm_*` callback
   - verify callback answer is attempted promptly and dialog resolution continues
3. **`pi_abort` remains responsive during a detached prompt**
4. **busy rejection is unchanged** for `/sessions`, `/new`, `/model`, tree actions, command-picker Pi entries while a prompt is active
5. **forum topic isolation** still holds with per-topic context keys

### Manual test checklist

In a real Telegram chat:

1. start a long extension flow (`/cron add` is the best candidate)
2. wait long enough that the original prompt is clearly still active
3. use callback-based dialog steps if available, or press `Abort`
4. verify the callback spinner resolves immediately instead of expiring
5. repeat in a forum topic to verify thread isolation

## Clear recommendation

### Do now

Implement the **small per-context background runner for prompt-starting flows only** and route these call sites through it:

- text prompts
- bridged Pi slash commands
- `/retry`
- native `/cron` menu prompt launches
- command picker Pi entries
- post-transcription prompt launches

Keep all existing stale-callback mitigations.

### Do later

Only after the above lands and is validated, decide whether TelePi needs a broader two-lane controller for:

- queued session mutations,
- priority abort/control handling,
- more formal callback/control vs prompt/work separation.

## Bottom line

The smallest safe architectural change is **not** a full callback queue and **not** blanket fire-and-forget.

It is:

> **Decouple long-running prompt execution from grammY update lifetime, per chat/topic, while preserving current busy rejection for other actions.**

That should eliminate the main callback-expiry path without forcing a broader architecture rewrite first.
