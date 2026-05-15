import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  describeCallbackQuerySource,
  isStaleCallbackQueryError,
  logCallbackQueryError,
  resetCallbackQueryLogStateForTests,
} from "../../src/bot/callback-query-logging.js";

describe("callback query logging", () => {
  beforeEach(() => {
    resetCallbackQueryLogStateForTests();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("classifies native command-menu and extension dialog callback families", () => {
    expect(describeCallbackQuerySource("cmdm_status")).toBe("native.command-menu");
    expect(describeCallbackQuerySource("ui_sel_abcd1234_1")).toBe("extension.select");
    expect(describeCallbackQuerySource("ui_cfm_abcd1234_yes")).toBe("extension.confirm");
    expect(describeCallbackQuerySource("ui_x_abcd1234")).toBe("extension.cancel");
  });

  it("deduplicates repeated stale callback answer errors while preserving the callback family", () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const ctx = {
      callbackQuery: {
        data: "ui_sel_abcd1234_1",
      },
    } as any;

    logCallbackQueryError(ctx, new Error("query is too old and response timeout expired or query id is invalid"), {
      phase: "answer",
      source: "extension.select",
      responseText: "Selected Beta",
    });
    logCallbackQueryError(ctx, new Error("query is too old and response timeout expired or query id is invalid"), {
      phase: "answer",
      source: "extension.select",
      responseText: "Selected Beta",
    });

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy.mock.calls[0]?.[0]).toContain("Ignored stale Telegram callback answer");
    expect(consoleErrorSpy.mock.calls[0]?.[0]).toContain("extension.select");
    expect(consoleErrorSpy.mock.calls[0]?.[0]).toContain("ui_sel_abcd1234_1");
    expect(consoleErrorSpy.mock.calls[0]?.[0]).toContain('reply="Selected Beta"');
  });

  it("logs stale native command-menu callback failures with the generic menu source", () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const ctx = {
      callbackQuery: {
        data: "cmdm_manage",
      },
    } as any;

    logCallbackQueryError(ctx, new Error("QUERY_ID_INVALID"), {
      phase: "handler",
    });

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy.mock.calls[0]?.[0]).toContain("Ignored stale Telegram callback query");
    expect(consoleErrorSpy.mock.calls[0]?.[0]).toContain("native.command-menu");
    expect(consoleErrorSpy.mock.calls[0]?.[0]).toContain("cmdm_manage");
  });

  it("re-logs stale callback errors after the dedup window with the suppressed count", () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const ctx = {
      callbackQuery: {
        data: "ui_sel_abcd1234_1",
      },
    } as any;

    logCallbackQueryError(ctx, new Error("query too old"), {
      phase: "answer",
      source: "extension.select",
      responseText: "Selected Beta",
    });
    logCallbackQueryError(ctx, new Error("query too old"), {
      phase: "answer",
      source: "extension.select",
      responseText: "Selected Beta",
    });
    vi.advanceTimersByTime(30_001);
    logCallbackQueryError(ctx, new Error("query too old"), {
      phase: "answer",
      source: "extension.select",
      responseText: "Selected Beta",
    });

    expect(consoleErrorSpy).toHaveBeenCalledTimes(2);
    expect(consoleErrorSpy.mock.calls[1]?.[0]).toContain("(+1 similar suppressed)");
  });

  it("detects stale callback query errors without matching unrelated failures", () => {
    expect(isStaleCallbackQueryError(new Error("query is too old and response timeout expired"))).toBe(true);
    expect(isStaleCallbackQueryError(new Error("QUERY_ID_INVALID"))).toBe(true);
    expect(isStaleCallbackQueryError(new Error("network down"))).toBe(false);
  });
});
