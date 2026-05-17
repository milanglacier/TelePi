# Review: feat: support direct `/new <path>` session creation

**Commit**: `50cef74`

## Findings

### 1. Duplicated `resolvePathFromCwd` logic — use the existing helper instead

The code at `src/bot/commands/sessions.ts:157-159` manually re-implements `expandHomePath` + `path.isAbsolute` + `path.resolve(process.cwd(), ...)` — the exact logic already provided by `resolvePathFromCwd` in `src/paths.ts`. That helper is used in 6+ other locations across the codebase. The inline version also calls `expandHomePath(workspaceArg)` three times for the same input (once for the `isAbsolute` check, and again in each branch).

```ts
// Current (3× expandHomePath):
const resolvedPath = path.isAbsolute(expandHomePath(workspaceArg))
  ? expandHomePath(workspaceArg)
  : path.resolve(process.cwd(), expandHomePath(workspaceArg));

// Should be:
const resolvedPath = resolvePathFromCwd(workspaceArg);
```

### 2. Test `"/new /etc/hostname"` is platform-dependent

The test at `test/bot.test.ts:1536` uses `/etc/hostname` to exercise the "path is not a directory" error. This file exists on Linux but not on macOS or other Unixes that store the hostname elsewhere. On those systems the test would fail with `"Workspace not found"` instead of `"Path is not a directory"`, because `existsSync` returns false before `statSync` is reached. A platform-independent fixture (e.g., a temp file created in `beforeEach`) would make the test portable.

## Verdict

**Needs minor revision.** The feature logic is correct and all 438 tests pass. The primary issue is code duplication of `resolvePathFromCwd`, which also causes a redundant triple invocation of `expandHomePath`. The `/etc/hostname` fixture is a minor portability concern.

---

## Fixes applied

### Fix 1 — Use `resolvePathFromCwd` instead of inline path resolution

In `src/bot/commands/sessions.ts`:
- Replaced `import { expandHomePath } from "../../paths.js"` with `import { resolvePathFromCwd } from "../../paths.js"`.
- Removed the now-unused `import path from "node:path"`.
- Replaced the 3-line inline resolution and triple `expandHomePath` call with a single `const resolvedPath = resolvePathFromCwd(workspaceArg);`.

### Fix 2 — Switch test fixture from `/etc/hostname` to `/dev/null`

In `test/bot.test.ts`:
- Changed the test path from `/etc/hostname` (Linux-only) to `/dev/null` (exists as a non-directory on all Unix systems).
- Updated assertion to match.

---

## Second-round review (post-fix, commit `18084e9`)

### 1. Duplicated success/error block between the explicit-path and no-argument branches

In `src/bot/commands/sessions.ts`, the 12-line `try` block that calls `newSession` and sends the success reply (lines 187–198) and the 6-line `catch` block that renders the failure (lines 199–204) are byte-for-byte identical to the same blocks in the no-argument branch (lines 220–231 and 232–237). The explicit-path branch introduced by this feature copies the existing no-argument flow's post-creation logic verbatim. Any future change to the session-creation reply (adding telemetry, adjusting formatting, adding a new side effect like `clearContextPromptMemory`) must be applied in both places, which is an easy regression vector.

```ts
// Appears identically at lines 187–198 and 220–231:
await refreshChatScopedCommands(target, piSession);
clearContextPickers(contextKey);
clearContextPromptMemory(target);
const plainText = `New session created.\n\n${renderSessionInfoPlain(info)}`;
const html = `<b>New session created.</b>\n\n${renderSessionInfoHTML(info)}`;
await safeReply(ctx, html, { fallbackText: plainText }, target);
await surfaceStartupErrorDiagnostics(ctx, target, info);
```

**Location**: `src/bot/commands/sessions.ts` lines 187–204 and 220–237

### 2. Test `/new ./src` is cwd-dependent

The test "resolves relative paths against cwd for /new <relative>" (`test/bot.test.ts:1558`) sends `/new ./src` and relies on the real `existsSync`/`statSync` calls (which are not mocked) to find `./src` as an existing directory. This only passes when the test runner's cwd is the project root. While Vitest runs from the project root by default, any custom runner configuration or monorepo tooling that changes cwd would cause this test to fail with "Workspace not found" instead of exercising the relative-path resolution path.

**Location**: `test/bot.test.ts` lines 1558–1568

### Verdict

**Approvable with minor notes.** Fix 1 from the first review (using `resolvePathFromCwd`) was applied correctly. The duplicated success/error block (finding 1) is the most actionable item — extracting a small `handleNewSessionResult` helper would eliminate the risk of future divergence. The `./src` fixture (finding 2) is lower severity; using a temp directory created in `beforeEach` would make the test self-contained.

---

## Fixes applied (second round, commit `46ef55d`)

### Fix 1 — Extract `handleNewSessionSuccess` helper

In `src/bot/commands/sessions.ts`:
- Extracted the 8-line post-creation block (refresh commands, clear pickers/memory, render info, diagnostics) into a `handleNewSessionSuccess` helper.
- Both the explicit-path branch and the no-argument branch now call `handleNewSessionSuccess(ctx, target, piSession, contextKey, info)` instead of duplicating the same 8 lines.
- Net change: +16 lines (helper definition), −16 lines (two removed dupes).

### Fix 2 — Use temp directory for relative-path test

In `test/bot.test.ts`:
- Replaced the hardcoded `./src` path with a `mkdtempSync`-created temp directory under `process.cwd()`.
- Computes a `path.relative()` from cwd to the temp directory and passes it as the `/new` argument.
- Assertion tightened from `expect(callArg).toContain(process.cwd())` to `expect(callArg).toBe(tempDir)`.
- Cleans up with `rmSync` in a `finally` block, matching the existing test pattern at line ~2499.
- All 438 tests pass, TypeScript compiles cleanly.

---

## Third-round review (post-fix, commit `46ef55d`)

### Status

All 438 tests pass. Both rounds of fixes are applied correctly:
- `expandHomePath` and `import path from "node:path"` are fully removed from `sessions.ts`.
- `resolvePathFromCwd` is used in place of inline path resolution. ✓
- `handleNewSessionSuccess` is extracted and called from both branches. ✓
- The `/etc/hostname` fixture is replaced with `/dev/null`. ✓
- The `./src` test now uses a `mkdtempSync`-created temp directory. ✓

### 1. Missing error/cancelled tests for the explicit-path `/new <path>` branch

The no-argument `/new` branch has existing tests for both the `created: false` cancellation path (line 3423) and the `newSession` throwing path (line 3440). These exercise the `try/catch`/`!created` logic that exists in **both** the no-argument and explicit-path branches of `handleNewCommand`. However, the explicit-path branch has no equivalent tests — the 5 new tests only cover the success, not-found, not-a-directory, tilde-expansion, and relative-resolution paths.

If a future refactor inadvertently removes or breaks the `!created` check or the `catch` block in the explicit-path branch, existing tests will not catch the regression. Adding two mirror tests would close the gap:

```ts
// Suggested additions (in the explicit-path test block around line 1577):

// Cancelled explicit-path session
it("shows cancelled message when /new <path> newSession returns created: false", async () => {
  const { bot, api, pi } = setupBot({
    piSessionOverrides: {
      newSession: vi.fn().mockResolvedValue({
        info: { sessionId: "id", sessionFile: "/f", workspace: "/tmp", model: "m" },
        created: false,
      }),
    },
  });
  await bot.handleUpdate(createTestUpdate({ message: { text: "/new /tmp" } }));
  expect(api.sendMessage.mock.calls[0]?.[1]).toContain("New session was cancelled.");
});

// Explicit-path session throws
it("renders error when /new <path> newSession throws", async () => {
  const { bot, api } = setupBot({
    piSessionOverrides: {
      newSession: vi.fn().mockRejectedValue(new Error("explicit new failed")),
    },
  });
  await bot.handleUpdate(createTestUpdate({ message: { text: "/new /tmp" } }));
  expect(api.sendMessage.mock.calls[0]?.[1]).toContain("explicit new failed");
});
```

**Location**: `sessions.ts` lines 188–204 (the `try/catch`/`!created` block in the explicit-path branch)

**Severity**: Low. The production code is structurally identical to the tested no-argument branch (same `try/catch` pattern, same `!created` guard, same `handleNewSessionSuccess` call). The gap is purely a coverage one.

### 2. Minor residual duplication: `!created` check and `catch` block

The second-round fix extracted the 8-line `handleNewSessionSuccess` success-rendering block, which was the highest-value extraction (multiple side effects: `refreshChatScopedCommands`, `clearContextPickers`, `clearContextPromptMemory`, `safeReply`, `surfaceStartupErrorDiagnostics`). Two smaller blocks remain duplicated between branches:

- The `!created` cancellation guard (5 lines: `safeReply` with "New session was cancelled.")
- The `catch` block (6 lines: `renderFailedText` + `safeReply`)

These are simple, low-churn patterns unlikely to change independently of each other. Extracting them further would add indirection without meaningful maintainability gain. Acceptable as-is.

### Verdict

**Approved.** All prior findings are resolved correctly. The only remaining item (finding 1) is a test-coverage gap for error/cancellation paths in the explicit-path branch — low severity since the production code mirrors the already-tested no-argument branch. 438/438 tests pass, TypeScript compiles cleanly, and the diff is net-negative lines after both rounds of deduplication.

---

## Fixes applied (third round, commit `d9c5ffc`)

### Fix — Add cancelled/error tests for the explicit-path `/new <path>` branch

In `test/bot.test.ts`:
- Added test: `"shows cancelled message when /new <path> newSession returns created: false"` — mocks `newSession` to return `{ created: false }` when called with `/new /tmp`, asserts the reply contains `"New session was cancelled."`
- Added test: `"renders error when /new <path> newSession throws"` — mocks `newSession` to reject with `Error("explicit new failed")`, asserts the reply contains the error message.
- Both tests follow the same pattern as the existing no-argument `cancelledNew`/`failedNew` tests at lines 3423–3448.
- All 440 tests pass.
