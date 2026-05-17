# Plan: Direct `/new <path>` Session Creation (Skip Picker)

## Goal
When a user types `/new ~/Desktop/personal-projects/Telepi` (or any explicit path), TelePi should create a new session with that cwd directly, without showing the workspace picker UI. The picker should only appear when `/new` is invoked with no arguments and there are 2+ known workspaces.

## Confirmed Decisions
1. **Path validation**: Validate path exists AND is a directory before calling `newSession`. Error messages distinguish "not found" from "not a directory".
2. **Relative path base**: Resolve relative paths against `process.cwd()`.
3. **No `listWorkspaces()` call**: Skip `listWorkspaces()` entirely in the explicit-path branch — the user told us where to go.
4. **Argument parsing**: Use regex-based extraction (like `handleSessionsCommand`): `rawText.replace(/^\/new(?:@\w+)?\s*/, "").trim()`
5. **Error messages**: Show resolved absolute path. "Workspace not found: /path" for missing directories; "Path is not a directory: /path" for files.

## Changes

### 1. `src/bot/commands/sessions.ts` — `handleNewCommand`

**Signature change**: Add 3rd parameter `commandText?: string`.

**New control flow**:
```
handleNewCommand(ctx, target, commandText?):
  1. Busy check (preserved as-is)
  2. Extract workspace arg from commandText (regex strip /new prefix)
  3. IF workspace arg is non-empty:
     a. Resolve path: expandHomePath() → path.isAbsolute? keep : path.resolve(process.cwd())
     b. existsSync(resolvedPath) → if false, reply "Workspace not found: <path>" and return
     c. statSync → if not directory, reply "Path is not a directory: <path>" and return
     d. piSession.newSession(resolvedPath) — direct call, no listWorkspaces()
     e. On success: refreshChatScopedCommands, clearContextPickers, clearContextPromptMemory,
        reply with session info HTML, surfaceStartupErrorDiagnostics
     f. On error: renderFailedText(error)
  4. ELSE (no workspace arg): existing behavior unchanged
     a. listWorkspaces() → ≤1: direct create | 2+: picker UI
```

**Imports to add** (at top of `sessions.ts`):
- `import { existsSync, statSync } from "node:fs";`  
- `import path from "node:path";`
- `import { expandHomePath } from "../../paths.js";`

### 2. `src/bot.ts` — Command registration (line 694)

Change from:
```ts
bot.command("new", async (ctx) => {
    const target = getTelegramTarget(ctx);
    if (!target) return;
    await handleNewCommand(ctx, target);
});
```
To:
```ts
bot.command("new", async (ctx) => {
    const target = getTelegramTarget(ctx);
    if (!target) return;
    await handleNewCommand(ctx, target, ctx.message?.text);
});
```

### 3. `test/bot.test.ts` — New test cases

| Test | Setup | Assertion |
|------|-------|-----------|
| `/new /valid/workspace` creates directly | Mock `statSync`/`existsSync` → true | `newSession` called with resolved path; no picker keyboard sent |
| `/new /nonexistent` shows error | Mock `existsSync` → false | Reply contains "Workspace not found: /nonexistent" |
| `/new /some/file` (not a directory) | Mock exists→true, stat→file | Reply contains "Path is not a directory: /some/file" |
| `/new ~/path` expands tilde | Path with `~` prefix | `expandHomePath` called; resolved path passed to `newSession` |
| `/new ./relative` resolves against cwd | Relative path | Resolved to absolute via `path.resolve(process.cwd())` |
| `/new` (no argument) still shows picker | Multiple workspaces | Picker keyboard sent (existing behavior preserved) |
| `/new` while busy shows error | Set busy state | "Cannot create new session while a prompt is running." |

### Files Modified
| File | Change |
|------|--------|
| `src/bot/commands/sessions.ts` | Add `commandText` param, path-resolution logic, imports |
| `src/bot.ts` | Forward `ctx.message?.text` to `handleNewCommand` |
| `test/bot.test.ts` | 7 new test cases |

### Implementation Order
1. Add imports (`existsSync`, `statSync`, `path`, `expandHomePath`) to `sessions.ts`
2. Modify `handleNewCommand` signature and body
3. Update `/new` registration in `bot.ts`
4. Write tests
5. Run `npm test` to verify
