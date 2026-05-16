# Code Review: Fix Async Subagent Compatibility Gaps

**Commit**: `c0576b6b88d6001e96b4eba1a41e7a65fbbf2371`
**Plan**: `docs/fix-async-compatability-gaps.md`
**Date**: 2026-05-15

This review covers the implementation across 6 source files and 4 test files introduced by this commit (993 additions, 1 deletion).

---

## 1. Implementation Review

### 1a. Corner Cases and Bugs

#### 🔴 Bug 1: Stale `inAutonomousTurn` flag race condition (`pi-session.ts`)

In `rebindAutonomousSubscription()`, the closure-local `inAutonomousTurn` flag tracks whether the autonomous subscription is inside an autonomous turn. When an autonomous turn is mid-stream and a user prompt flow starts:

1. `setPromptFlowActive(true)` is called (line 466 of `prompt-handler.ts`)
2. `piSession.prompt()` aborts/completes the ongoing autonomous turn → `agent_end` fires
3. The subscription sees `isPromptFlowActiveFlag === true`, returns early at line 1224, and **never resets `inAutonomousTurn`**
4. When the prompt flow ends (`setPromptFlowActive(false)`), `inAutonomousTurn` is still `true`
5. Next autonomous turn: first `text_delta` arrives, but `inAutonomousTurn === true` so `onAutonomousStart()` is **skipped**
6. `onAutonomousStart` is responsible for resetting `accumulatedText`, `responseMessageId`, `finalized`, etc.
7. **The next autonomous turn mixes content from the previous turn into the same Telegram message**

**Location**: `src/pi-session.ts`, lines 1212–1255 (`rebindAutonomousSubscription`)

**Fix** — reset `inAutonomousTurn` on `agent_end` even when `isPromptFlowActiveFlag` is true:

```typescript
case "agent_end":
  if (inAutonomousTurn) {
    inAutonomousTurn = false;
    if (!this.isPromptFlowActiveFlag) {
      callbacks.onAutonomousEnd();
    }
  }
  break;
```

This way the state machine stays accurate regardless of gating, and the next autonomous turn will correctly call `onAutonomousStart()`.

---

#### 🟡 Issue 2: `subagent-events.ts` is dead code

`formatControlEventNotice()` and `formatNotifyMessage()` are exported from `src/bot/subagent-events.ts` but are **never imported or called anywhere in the codebase**. The plan's Step 5 ("Control Event Direct Notification" — registering `pi.events` listeners on `subagent:control-event`) was **not implemented**.

The `getBySessionId()` method in `PiSessionRegistry` (line 1340 of `pi-session.ts`) was added to support the session-to-chat lookup needed for control events, but it is also **never called**.

These functions and types have clean tests, but serve no purpose in the running system:

- No `pi.events` listener is registered
- No Telegram notification is sent for control events (`active_long_running`, `needs_attention`)
- No completion notice is sent when subagent async runs finish

**Recommendation**: Either wire these up in a follow-up PR per the plan, or remove the dead code until it is integrated.

---

#### 🟡 Issue 3: `onToolStart`/`onToolEnd` in autonomous-handler.ts don't send tool messages

In `autonomous-handler.ts`, `onAutonomousToolStart` (line 257) and `onAutonomousToolEnd` (line 270) only maintain a `toolStates` map — they **never send Telegram messages** for tool visibility. Compare with `prompt-handler.ts`, where `onToolStart`/`onToolEnd` send separate messages with `renderToolStartMessage`/`renderToolEndMessage`.

Additional dead code:
- The `ToolState` type (line 24) defines a `finalStatus` field that is **never assigned**
- The `toolStates` map is written to and cleared, but the stored data is **never read** for message generation

In `toolVerbosity: "all"` mode, the autonomous handler cannot show tool progress — it silently discards all tool events. The plan states that `onAutonomousToolStart`/`onAutonomousToolEnd` should provide "optional progress" but the implementation doesn't deliver it.

---

#### 🔶 Issue 4: No `agent_start` → typing indicator starts late

The subscription detects autonomous turns via `text_delta` or `tool_execution_start` — there's no `agent_start` event in pi's `AgentSession.subscribe()` API. This means `onAutonomousStart()` (which starts the typing indicator via `sendChatAction`) fires *after* the first content delta arrives, not before. For quick autonomous responses, the typing indicator may flash late or not appear at all.

---

#### 🟢 Minor: `stripAnsiEscapes` regex slightly over-broad

The regex `/\x1b\[[0-9;?]*[a-zA-Z]/g` in `message-rendering.ts` line 463 matches any letter as the terminator (`[a-zA-Z]`). Valid ANSI escape sequences end with specific letters (A–H, J, K, S, T, f, h, l, m, n, p, q, r). In practice this won't cause false matches because `\x1b` (ESC) is rare outside ANSI sequences, but the regex could be tightened to something like `/\x1b\[[0-9;?]*[A-Za-z]/g` or `/\x1b\[[0-9;]*[A-HJKSTfhilmnpqrsu]/g` for stricter matching.

---

#### 🟢 Minor: `getBySessionId` iteration is O(n)

`getBySessionId` (line 1340) iterates all services linearly. For a bot with many users, this is O(n) per lookup. Since it's not yet called, this isn't a current problem, but when wired up for control events, consider maintaining a reverse index (`Map<sessionId, contextKey>`) updated on session creation/removal.

---

### 1b. Overall Logic Assessment

The **core architecture** (persistent subscription + `isPromptFlowActive` gating) is sound and correctly prevents double-handling between per-prompt and autonomous subscriptions:

- `subscribeAutonomous()` registers callbacks persistently, mirroring the existing `sessionCallbacks` pattern
- `isPromptFlowActiveFlag` gates the autonomous subscription to suppress events during user-initiated prompts
- `setPromptFlowActive()` is called in `prompt-handler.ts` with proper `try/finally` wrapping (lines 466–501)
- `rebindAutonomousSubscription()` is called after session switches (line 1310), correctly re-establishing the listener on the new session

The **autonomous handler** (`autonomous-handler.ts`) correctly implements:
- Debounced editing with `AUTONOMOUS_EDIT_DEBOUNCE_MS` (1500ms)
- Concurrent request gating via `isFlushing`/`flushPending`
- Tool summary line in `buildFinalResponseText` for `toolVerbosity: "summary"`
- Graceful empty-response handling with "✅ Done (autonomous)" fallback

The **ANSI stripping** (`stripAnsiEscapes`) is applied at the correct points in the tool output callbacks within `prompt-handler.ts` (lines 419 and 431).

The **cleanup paths** are thorough — autonomous subscriptions are cleaned up in `dispose()`, `handback()`, `disposeHandleAfterRebindFailure()`, and via `clearContextPickers()` in bot.ts.

---

## 2. Test Review

### 2a. Tests that make sense

| Test | Location | Assessment |
|------|----------|------------|
| `stripAnsiEscapes` strips ANSI sequences | `test/bot/message-rendering.test.ts:183` | ✅ Good — covers basic colors, bold+color, plain text, multi-line with mixed ANSI |
| `setPromptFlowActive` tracks flag | `test/pi-session.test.ts:1951` | ✅ Verifies flag toggles true/false correctly |
| `subscribeAutonomous` gating | `test/pi-session.test.ts:1963` | ✅ Tests forwarding when flag is off, suppression when on, and resumption after flag clears |
| `getBySessionId` with message thread | `test/pi-session.test.ts:2180` | ✅ Correctly resolves context with `{ chatId, messageThreadId }` |
| `getBySessionId` without thread | `test/pi-session.test.ts:2190` | ✅ Correctly resolves context with `{ chatId }` only |
| Autonomous handler start/stop lifecycle | `test/bot/autonomous-handler.test.ts:52` | ✅ Basic start/stop works, validates `subscribeAutonomous` call |
| `formatControlEventNotice` all field coverage | `test/bot/subagent-events.test.ts` | ✅ Covers `needs_attention`, `active_long_running`, tool info, failure summary, turn/token counts |
| `formatNotifyMessage` all statuses + truncation | `test/bot/subagent-events.test.ts` | ✅ Covers completed, failed (with task info + duration), paused, and 400-char truncation |

### 2b. Tests that are misleading or vacuously passing

#### 🔴 "shows individual tool messages in all verbosity mode" (line 175)

```typescript
callbacks.onAutonomousToolStart("bash", "tool-1");
callbacks.onAutonomousTextDelta("Running");
// Tool start sends a separate message
expect(api.sendMessage.mock.calls.length).toBeGreaterThanOrEqual(1);
```

This test passes because `onAutonomousTextDelta("Running")` triggers `sendMessage` — **not** because `onAutonomousToolStart` sends anything. The tool start produces no Telegram message. The assertion `toBeGreaterThanOrEqual(1)` is satisfied by the text delta message alone. The test name and comment are misleading — **tool messages are never sent**.

#### 🔴 "ignores tools in none verbosity mode" (line 210)

```typescript
const toolMessages = api.sendMessage.mock.calls.filter(
  (call: any[]) => call[1]?.includes?.("Running:") || call[1]?.includes?.("✅"),
);
expect(toolMessages.length).toBe(0);
```

This test always passes because tools **never** produce messages in any verbosity mode. The assertion would return 0 even in `"all"` mode. The test passes vacuously.

#### 🔶 "accumulates text and finalizes on autonomous end" (line 108)

```typescript
expect(api.sendMessage.mock.calls.length + api.editMessageText.mock.calls.length).toBeGreaterThanOrEqual(1);
```

This only verifies that *some* message was sent — it doesn't check that the text accumulated via `onAutonomousTextDelta` actually appears in the final output. A stronger assertion would inspect the rendered content of the sent messages.

#### 🔶 "tracks tools in summary verbosity mode" (line 127)

Verifies that "Result" appears in messages and tool counts are tracked, but doesn't assert the actual tool summary line format (e.g., `*Tools used:*` or similar generated by `formatToolSummaryLine`).

---

## 3. Summary of Findings

| # | Severity | Description | Location |
|---|----------|-------------|----------|
| 1 | 🔴 Bug | `inAutonomousTurn` flag stale when prompt flow interrupts autonomous turn — causes content mixing in next autonomous response | `src/pi-session.ts:1212-1255` |
| 2 | 🟡 Dead code | `subagent-events.ts` formatting functions never wired up; `getBySessionId` never called | `src/bot/subagent-events.ts`, `src/pi-session.ts:1340` |
| 3 | 🟡 Missing feature | Autonomous handler doesn't display tool progress messages (unlike per-prompt handler); `ToolState.finalStatus` never set | `src/bot/autonomous-handler.ts:24-27, 257-280` |
| 4 | 🟡 Vacuously passing test | "shows individual tool messages in all verbosity mode" doesn't test tool messages | `test/bot/autonomous-handler.test.ts:175` |
| 5 | 🟡 Vacuously passing test | "ignores tools in none verbosity mode" always passes | `test/bot/autonomous-handler.test.ts:210` |
| 6 | 🔶 Weak assertion | "accumulates text and finalizes on autonomous end" only checks message count | `test/bot/autonomous-handler.test.ts:108` |
| 7 | 🟢 Minor UX | Typing indicator starts late (no `agent_start` in session subscription API) | `src/pi-session.ts:1229` |
| 8 | 🟢 Minor | `stripAnsiEscapes` regex slightly over-broad on terminator character class | `src/bot/message-rendering.ts:463` |
| 9 | 🟢 Minor | `getBySessionId` is O(n) — consider reverse index when wired up | `src/pi-session.ts:1340` |

### Recommended Priority

1. **Fix Bug #1** — the race condition is a correctness issue that can cause data corruption in Telegram messages
2. **Fix or remove #2** — wire up control event listeners per the plan, or remove dead code until integrated
3. **Fix or remove #3** — either implement tool message rendering in the autonomous handler, or simplify the handler to remove the unused `toolStates` / `ToolState` infrastructure
4. **Strengthen tests #4, #5, #6** — fix misleading assertions and add content verification

---

## 4. Implementation Response (2026-05-15)

All nine findings have been addressed. Each resolution is described below.

### Issue 1 ✅ — Stale `inAutonomousTurn` race condition (FIXED)

**File**: `src/pi-session.ts`

Restructured the subscription callback in `rebindAutonomousSubscription()` to handle `agent_end` events **before** the `isPromptFlowActiveFlag` early-return gate. `inAutonomousTurn` is always reset to `false` when `agent_end` fires, but `onAutonomousEnd()` is only called when no prompt flow is active. This prevents the flag from staying stale when a user prompt interrupts an autonomous turn mid-stream.

A dedicated regression test was added: `"resets autonomous turn state on agent_end even during prompt flow"` in `test/pi-session.test.ts`. The test simulates the exact race condition — autonomous turn starts, prompt flow activates (aborting the turn), `agent_end` fires during prompt flow, prompt flow ends, new autonomous turn starts — and verifies `onAutonomousStart` fires correctly.

### Issue 2 ✅ — Dead code: `subagent-events.ts` and `getBySessionId` (REMOVED)

**Files**: `src/bot/subagent-events.ts`, `test/bot/subagent-events.test.ts`, `src/pi-session.ts`, `test/pi-session.test.ts`

`subagent-events.ts` and its tests were deleted. The formatting functions (`formatControlEventNotice`, `formatNotifyMessage`) were never imported or called. Wiring them up requires `ExtensionAPI.events` which TelePi does not expose — the autonomous handler already covers the use case by streaming the LLM response to subagent-triggered turns.

`getBySessionId()` was removed from `PiSessionRegistry` along with its two tests. It was added solely to support the un-implemented control-event notification path and was never called.

### Issue 3 ✅ — Missing tool progress in autonomous handler (IMPLEMENTED)

**Files**: `src/pi-session.ts`, `src/bot/autonomous-handler.ts`

- Added `onAutonomousToolUpdate(toolCallId, partialResult)` to the `AutonomousCallbacks` interface
- Handle `tool_execution_update` events in the subscription, normalizing `partialResult` to a string
- Implemented full tool message rendering in the autonomous handler, mirroring `prompt-handler.ts`:
  - **`all` mode**: sends a tool-start message via `renderToolStartMessage`, then edits it on completion with `renderToolEndMessage` (result/error icon + partial output preview)
  - **`errors-only` mode**: sends a message only on tool errors
  - **`summary` mode**: counts tools (unchanged)
  - **`none` mode**: no tool messages (unchanged)
- `ToolState` now tracks `partialResult` (accumulated via `stripAnsiEscapes` + `appendWithCap`) and `finalStatus` is properly assigned from `renderToolEndMessage`
- The `onAutonomousToolStart` async callback stores `messageId` and handles the edge case where `finalStatus` is already set before the initial `sendTextMessage` resolves (tool-end arrives before the send completes)

### Issue 4 ✅ — Vacuous test: "shows individual tool messages in all verbosity mode" (FIXED)

**File**: `test/bot/autonomous-handler.test.ts`

Rewrote the test to actually verify tool message behavior:
- Asserts a `sendMessage` call contains the tool name ("bash") — proving `onAutonomousToolStart` sends a dedicated message
- Asserts an `editMessageText` call contains the result icon ("✅") — proving `onAutonomousToolEnd` edits the tool-start message
- Uses correct argument indices: `sendMessage(chatId, text, ...)` → `call[1]` is text; `editMessageText(chatId, messageId, text, ...)` → `call[2]` is text

### Issue 5 ✅ — Vacuous test: "ignores tools in none verbosity mode" (FIXED)

**File**: `test/bot/autonomous-handler.test.ts`

Replaced the fragile assertion (checking for "Running:" which tools never produced) with:
- Verifies no tool-marker messages (`🔧`, `✅`, `❌`) are present in any `sendMessage` calls
- Verifies text content ("Done") still streams through despite tools being suppressed

### Issue 6 ✅ — Weak assertion: "accumulates text and finalizes on autonomous end" (STRENGTHENED)

**File**: `test/bot/autonomous-handler.test.ts`

Changed from `toBeGreaterThanOrEqual(1)` (any message sent) to verifying the accumulated text ("Autonomous response") actually appears in the output message content.

### Issue 7 🟢 — Typing indicator starts late (ACKNOWLEDGED — pi API limitation)

`agent_start` exists in `ExtensionEvent` but is not part of `AgentEvent` emitted by `AgentSession.subscribe()`. The typing indicator starts on the first `text_delta` or `tool_execution_start`, which is the earliest available hook in the current pi API. This cannot be fixed without changes to `@earendil-works/pi-coding-agent`.

### Issue 8 ✅ — Over-broad `stripAnsiEscapes` regex (TIGHTENED)

**File**: `src/bot/message-rendering.ts`

Changed terminator character class from `[a-zA-Z]` to `[A-HJKSTfhilmnpqrsu]` — matching only valid ANSI escape sequence terminators (A–H = cursor movement, J/K = erase, S/T = scroll, f/h/l = cursor position, i/m = mode, n/p = device status, q/r = set/reset, s/u = save/restore cursor).

### Issue 9 🟢 — O(n) `getBySessionId` (MOOT)

Removed along with Issue 2 — the method was dead code. If session-to-chat reverse lookup is needed in the future, it can be re-added with a `Map<sessionId, contextKey>` index.

### Test infrastructure improvements

All tests in `test/bot/autonomous-handler.test.ts` now use `vi.advanceTimersByTimeAsync(2000)` instead of `vi.runAllTimersAsync()` to avoid infinite timer loops from the typing indicator's `setInterval`. The `flushAsyncWork()` helper advances past the 1500ms edit debounce timeout while staying under the 4500ms typing interval.

Two new tests were added:
- `"accumulates tool partial results via onAutonomousToolUpdate"` — verifies partial results accumulate and appear in the tool-end edit
- `"sends tool error messages in errors-only verbosity mode"` — verifies errors-only mode sends a message only on failure

### Build verification

- TypeScript compiles cleanly (`tsc --noEmit`)
- All 392 tests pass across 27 test files
- Coverage thresholds met: 85.95% statements, 81.52% branches, 90.41% functions

---

## 5. Second-Round Review & Fix (2026-05-15)

### New Finding: `partialResult` Normalization Inconsistency

**Severity**: 🟢 Minor (no runtime impact in practice)

**Location**: `src/pi-session.ts`, line 1263 (`rebindAutonomousSubscription`)

The per-prompt session subscription (line 576) normalizes `partialResult` via `stringifyToolData()` which does `JSON.stringify(value, null, 2)` for non-string values. The autonomous subscription (line 1263) used an inline `typeof`/`String()` conversion instead, which would produce `"[object Object]"` for the same input.

In practice pi always emits `partialResult` as a string (tool output text), so both paths behave identically. The fix replaces the inline logic with a call to `stringifyToolData` for consistency.

**Fix**:

```diff
- typeof event.partialResult === "string" ? event.partialResult : String(event.partialResult ?? ""),
+ stringifyToolData(event.partialResult),
```

**Verification**: `tsc --noEmit` clean, all 392 tests pass.
