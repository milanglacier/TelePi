# Plan: Fix Async Subagent Compatibility Gaps in TelePi

## Goal

Make TelePi fully compatible with pi-subagents' async completion and control event features, without modifying pi-subagents' code. Two gaps exist:

1. **Gap 1 (Async Completion)**: `pi.sendMessage({ customType: "subagent-notify", ... }, { triggerTurn: true })` starts an autonomous LLM turn. TelePi only subscribes to AgentSession events during active user prompts, so the LLM's response is never streamed to Telegram.

2. **Gap 2 (Control Events)**: `SUBAGENT_CONTROL_EVENT` fires for long-running/attention-needed subagents. TelePi has no listener, so users get no visibility.

## Root Cause

Both gaps share the same root cause: **TelePi has no persistent session event listener**. It only subscribes to `AgentSession.subscribe()` during the lifecycle of a user-initiated prompt (`runPromptFlow`). When the prompt completes, the subscription is torn down. Any subsequent autonomous LLM turn (triggered by `sendCustomMessage({ triggerTurn: true })`) produces events that nobody receives.

## Solution Overview

1. Add a **persistent** subscription on each `PiSessionService` that lives across prompts
2. This listener detects "autonomous" turns (agent events with no active user prompt) and streams them to Telegram
3. Register `pi.events` listeners for `subagent:control-event` to send immediate Telegram notifications
4. Strip ANSI escape codes from tool output

---

## Implementation Steps

### Step 1: ANSI Stripping (standalone, low risk)

**File**: `src/bot/message-rendering.ts`

- Add `stripAnsiEscapes(text: string): string` using regex `/\x1b\[[0-9;]*[a-zA-Z]/g`
- Apply in `onToolUpdate`/`onToolEnd` callbacks in `prompt-handler.ts`

### Step 2: Autonomous Turn Detection — PiSessionService

**File**: `src/pi-session.ts`

Add a persistent event subscription that outlives individual prompt flows:

```typescript
export interface AutonomousCallbacks {
  onAutonomousStart(): void;
  onAutonomousTextDelta(delta: string): void;
  onAutonomousToolStart(toolName: string, toolCallId: string): void;
  onAutonomousToolEnd(toolCallId: string, isError: boolean): void;
  onAutonomousEnd(): void;
}
```

- Add `isPromptFlowActive` flag to `PiSessionService` — set `true` when a user prompt flow starts, `false` when it completes
- Add `subscribeAutonomous(callbacks: AutonomousCallbacks): () => void` — registers a **permanent** `AgentSession.subscribe()` listener
- The listener only forwards events when `isPromptFlowActive === false` and an autonomous turn is detected (tracks `agent_start`/`agent_end` pairing)
- This subscription is re-established after session switches (like the existing `sessionCallbacks` pattern)
- Store as `autonomousCallbacks` + `autonomousUnsubscribe` alongside existing `sessionCallbacks` + `sessionUnsubscribe`

### Step 3: Autonomous Handler — Stream to Telegram

**New file**: `src/bot/autonomous-handler.ts`

This mirrors the streaming logic in `prompt-handler.ts` but simplified (no slash command sync, no extension binding):

- On `onAutonomousStart()`: Send a Telegram message with typing indicator (similar to `ensureResponseMessage`)
- On `onAutonomousTextDelta(delta)`: Edit the message (debounced, like `scheduleFlush`)
- On `onAutonomousEnd()`: Finalize the message (rendered markdown → HTML, remove abort keyboard)
- Manages its own message ID and edit state
- Uses the same `splitMarkdownForTelegram` / `renderMarkdownChunkWithinLimit` utilities

### Step 4: Wire Up in bot.ts

**File**: `src/bot.ts`

When a `PiSessionService` is created for a chat context:

```typescript
piSession.subscribeAutonomous({
  onAutonomousStart() { /* start streaming */ },
  onAutonomousTextDelta(delta) { /* edit message */ },
  onAutonomousToolStart(toolName, toolCallId) { /* optional progress */ },
  onAutonomousToolEnd(toolCallId, isError) { /* optional progress */ },
  onAutonomousEnd() { /* finalize message */ },
});
```

- Cleanup on session disposal
- Pass `bot`, `target` (chat context), and config options

### Step 5: Control Event Direct Notification

**New file**: `src/bot/subagent-events.ts`

Register `pi.events` listeners to send immediate Telegram notifications for subagent control events:

```typescript
export function registerSubagentEventListeners(
  pi: ExtensionAPI,
  resolveTarget: (sessionId: string) => PiSessionContext | undefined,
  bot: Bot<Context>,
): () => void;
```

- Listen on `pi.events.on("subagent:control-event", ...)` 
- On event, resolve the target Telegram chat using session ID mapping
- Send a formatted Telegram message with the control notice details
- Return an unsubscribe function for cleanup

Since `pi.events` is process-wide, we need session → chat mapping. The `PiSessionRegistry` already maintains this. The event payload includes `runId` and `agent` — we can look up which session spawned the run.

**Alternative simplification**: Since the persistent session listener (Step 2–4) will capture the LLM's response to the `sendCustomMessage` notification, we could skip direct `pi.events` listeners and rely solely on the autonomous handler. However, direct notification provides **immediate** visibility (before the LLM finishes its turn) and works even if the LLM turn fails. **Recommendation**: Implement both — autonomous handler for the LLM response, and a lightweight direct notification for critical control events.

### Step 6: Update prompt-handler.ts Flag

**File**: `src/bot/prompt-handler.ts`

Wrap `piSession.prompt()` in `runPromptFlow` with:

```typescript
piSession.setPromptFlowActive(true);
try {
  await piSession.prompt(userText, images);
  await finalizeResponse();
} catch (error) {
  // ... error handling
} finally {
  piSession.setPromptFlowActive(false);
  unsubscribe();
}
```

### Step 7: Tests

| Test file | What it covers |
|-----------|---------------|
| `test/bot/autonomous-handler.test.ts` | Autonomous turn streaming to Telegram |
| `test/bot/subagent-events.test.ts` | Control event notification routing |
| `test/pi-session.test.ts` (extend) | `isPromptFlowActive`, `subscribeAutonomous` |
| `test/bot/message-rendering.test.ts` (extend) | `stripAnsiEscapes` |

---

## Key Design Decisions

1. **Persistent subscription vs. polling**: Persistent `AgentSession.subscribe()` is the cleanest approach — it receives events as they happen, with no latency.

2. **Autonomous vs. prompt-flow gating**: Use `isPromptFlowActive` flag to prevent double-handling. The per-prompt subscription handles events during user prompts; the persistent subscription handles autonomous turns only.

3. **Event constant coupling**: Hardcoding `"subagent:control-event"` is acceptable — these are stable event names and importing from pi-subagents internals would create a hard dependency.

4. **Session → chat mapping for `pi.events`**: The `PiSessionRegistry` (`services` map) already tracks `PiSessionContext` per session. We can expose a lookup method.

## Files Summary

| File | Action |
|------|--------|
| `src/pi-session.ts` | Add `AutonomousCallbacks` type, `subscribeAutonomous()`, `isPromptFlowActive` flag, persistent subscription lifecycle |
| `src/bot/autonomous-handler.ts` | **New** — streams autonomous LLM turns to Telegram |
| `src/bot/subagent-events.ts` | **New** — `pi.events` listeners for direct control notifications |
| `src/bot.ts` | Wire up autonomous handler + subagent event listeners on session creation |
| `src/bot/prompt-handler.ts` | Set/clear `isPromptFlowActive` around prompt flow |
| `src/bot/message-rendering.ts` | Add `stripAnsiEscapes()` utility |
| `test/bot/autonomous-handler.test.ts` | **New** |
| `test/bot/subagent-events.test.ts` | **New** |

## Implementation Order

1. ✏️ `message-rendering.ts` — ANSI stripping (simplest, standalone)
2. ✏️ `pi-session.ts` — Add autonomous subscription infrastructure  
3. 🆕 `autonomous-handler.ts` — Autonomous turn streaming
4. ✏️ `prompt-handler.ts` — Set/clear `isPromptFlowActive` flag
5. ✏️ `bot.ts` — Wire everything together
6. 🆕 `subagent-events.ts` — Direct control event notifications
7. 🧪 Tests for all of the above
