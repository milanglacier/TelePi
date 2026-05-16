import { describe, expect, it, vi } from "vitest";

import { createAutonomousHandler } from "../../src/bot/autonomous-handler.js";
import type { ToolVerbosity } from "../../src/config.js";
import type { PiSessionContext, PiSessionService } from "../../src/pi-session.js";
import type { Context } from "grammy";

function createMockApi() {
  return {
    sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
    editMessageText: vi.fn().mockResolvedValue({ ok: true }),
    editMessageReplyMarkup: vi.fn().mockResolvedValue({ ok: true }),
    sendChatAction: vi.fn().mockResolvedValue({ ok: true }),
  };
}

function createMockBot(api: ReturnType<typeof createMockApi>) {
  return {
    api: api as any,
  } as any;
}

function createMockSession(overrides: Partial<PiSessionService> = {}) {
  let autonomousCallbacks: any;
  const subscribeAutonomous = vi.fn().mockImplementation((callbacks: any) => {
    autonomousCallbacks = callbacks;
    return () => {
      if (autonomousCallbacks === callbacks) {
        autonomousCallbacks = undefined;
      }
    };
  });

  return {
    subscribeAutonomous,
    setPromptFlowActive: vi.fn(),
    getAutonomousCallbacks: () => autonomousCallbacks,
    ...overrides,
  } as unknown as PiSessionService;
}

const defaultTarget: PiSessionContext = { chatId: 12345 };

/** Advance far enough to flush the 1500ms edit debounce but stay under the 4500ms typing interval. */
async function flushAsyncWork(): Promise<void> {
  await vi.advanceTimersByTimeAsync(2000);
}

describe("autonomous handler", () => {
  it("starts and subscribes to autonomous events", () => {
    const api = createMockApi();
    const bot = createMockBot(api);
    const piSession = createMockSession();

    const handler = createAutonomousHandler({
      bot,
      target: defaultTarget,
      piSession,
      toolVerbosity: "summary",
    });

    handler.start();
    expect(piSession.subscribeAutonomous).toHaveBeenCalledTimes(1);
    handler.stop();
  });

  it("stops typing and marks finalized on stop", () => {
    const api = createMockApi();
    const bot = createMockBot(api);
    const piSession = createMockSession();

    const handler = createAutonomousHandler({
      bot,
      target: defaultTarget,
      piSession,
      toolVerbosity: "summary",
    });

    handler.start();
    handler.stop();
    // No error expected
  });

  it("streams autonomous text deltas to Telegram", async () => {
    vi.useFakeTimers();
    const api = createMockApi();
    const bot = createMockBot(api);
    const piSession = createMockSession();

    const handler = createAutonomousHandler({
      bot,
      target: defaultTarget,
      piSession,
      toolVerbosity: "summary",
    });

    handler.start();
    const callbacks = (piSession as any).getAutonomousCallbacks();
    expect(callbacks).toBeDefined();

    callbacks.onAutonomousStart();
    callbacks.onAutonomousTextDelta("Hello ");

    // Advance past debounce timeout so the message is sent
    await flushAsyncWork();

    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    handler.stop();
    vi.useRealTimers();
  });

  it("accumulates text and finalizes on autonomous end", async () => {
    vi.useFakeTimers();
    const api = createMockApi();
    const bot = createMockBot(api);
    const piSession = createMockSession();

    const handler = createAutonomousHandler({
      bot,
      target: defaultTarget,
      piSession,
      toolVerbosity: "summary",
    });

    handler.start();
    const callbacks = (piSession as any).getAutonomousCallbacks();

    callbacks.onAutonomousStart();
    callbacks.onAutonomousTextDelta("Autonomous response");
    await flushAsyncWork();

    callbacks.onAutonomousEnd();
    await flushAsyncWork();

    // The final message should contain the accumulated text.
    // sendTextMessage → api.sendMessage(chatId, text, ...)
    // safeEditMessage → bot.api.editMessageText(chatId, messageId, text, ...)
    const allCalls = [
      ...api.sendMessage.mock.calls,
      ...api.editMessageText.mock.calls,
    ];
    const messages = allCalls.map((call: any[]) => {
      // sendMessage: text is call[1]; editMessageText: text is call[2]
      if (call.length >= 3) return call[2];
      return call[1];
    });
    const combinedText = messages.join(" ");
    expect(combinedText).toContain("Autonomous response");

    handler.stop();
    vi.useRealTimers();
  });

  it("tracks tools in summary verbosity mode", async () => {
    vi.useFakeTimers();
    const api = createMockApi();
    const bot = createMockBot(api);
    const piSession = createMockSession();

    const handler = createAutonomousHandler({
      bot,
      target: defaultTarget,
      piSession,
      toolVerbosity: "summary",
    });

    handler.start();
    const callbacks = (piSession as any).getAutonomousCallbacks();

    callbacks.onAutonomousStart();
    callbacks.onAutonomousToolStart("bash", "tool-1");
    callbacks.onAutonomousTextDelta("Result");
    await flushAsyncWork();
    callbacks.onAutonomousEnd();
    await flushAsyncWork();

    // In summary mode, the final text should include tool summary
    const allCalls = [
      ...api.sendMessage.mock.calls,
      ...api.editMessageText.mock.calls,
    ];
    const messages = allCalls.map((call: any[]) => {
      if (call.length >= 3) return call[2];
      return call[1];
    });
    const combinedText = messages.join(" ");
    expect(combinedText).toContain("Result");

    handler.stop();
    vi.useRealTimers();
  });

  it("shows individual tool messages in all verbosity mode", async () => {
    vi.useFakeTimers();
    const api = createMockApi();
    const bot = createMockBot(api);
    const piSession = createMockSession();

    const handler = createAutonomousHandler({
      bot,
      target: defaultTarget,
      piSession,
      toolVerbosity: "all",
    });

    handler.start();
    const callbacks = (piSession as any).getAutonomousCallbacks();

    callbacks.onAutonomousStart();
    callbacks.onAutonomousToolStart("bash", "tool-1");
    callbacks.onAutonomousTextDelta("Running");
    await flushAsyncWork();

    // Tool start sends a dedicated message with the tool name.
    // sendTextMessage → api.sendMessage(chatId, text, ...)
    const toolStartCall = api.sendMessage.mock.calls.find(
      (call: any[]) => call[1]?.includes?.("bash"),
    );
    expect(toolStartCall).toBeDefined();

    callbacks.onAutonomousToolEnd("tool-1", false);
    await flushAsyncWork();

    // Tool end edits the tool start message with the result icon.
    // safeEditMessage → bot.api.editMessageText(chatId, messageId, text, ...)
    const toolEndEdit = api.editMessageText.mock.calls.find(
      (call: any[]) => call[2]?.includes?.("✅"),
    );
    expect(toolEndEdit).toBeDefined();

    handler.stop();
    vi.useRealTimers();
  });

  it("ignores tools in none verbosity mode", async () => {
    vi.useFakeTimers();
    const api = createMockApi();
    const bot = createMockBot(api);
    const piSession = createMockSession();

    const handler = createAutonomousHandler({
      bot,
      target: defaultTarget,
      piSession,
      toolVerbosity: "none" as ToolVerbosity,
    });

    handler.start();
    const callbacks = (piSession as any).getAutonomousCallbacks();

    callbacks.onAutonomousStart();
    callbacks.onAutonomousToolStart("bash", "tool-1");
    callbacks.onAutonomousToolEnd("tool-1", false);
    callbacks.onAutonomousTextDelta("Done");
    await flushAsyncWork();
    callbacks.onAutonomousEnd();
    await flushAsyncWork();

    // Only text-related messages should be sent; no tool messages.
    const toolCalls = api.sendMessage.mock.calls.filter(
      (call: any[]) => {
        const text = call[1] ?? "";
        return text.includes("🔧") || text.includes("✅") || text.includes("❌");
      },
    );
    expect(toolCalls.length).toBe(0);

    // Text content should still be streamed
    const allCalls = [
      ...api.sendMessage.mock.calls,
      ...api.editMessageText.mock.calls,
    ];
    const messages = allCalls.map((call: any[]) => {
      if (call.length >= 3) return call[2];
      return call[1];
    });
    const combinedText = messages.join(" ");
    expect(combinedText).toContain("Done");

    handler.stop();
    vi.useRealTimers();
  });

  it("accumulates tool partial results via onAutonomousToolUpdate", async () => {
    vi.useFakeTimers();
    const api = createMockApi();
    const bot = createMockBot(api);
    const piSession = createMockSession();

    const handler = createAutonomousHandler({
      bot,
      target: defaultTarget,
      piSession,
      toolVerbosity: "all",
    });

    handler.start();
    const callbacks = (piSession as any).getAutonomousCallbacks();

    callbacks.onAutonomousStart();
    callbacks.onAutonomousToolStart("bash", "tool-1");
    callbacks.onAutonomousToolUpdate("tool-1", "partial output");
    callbacks.onAutonomousToolUpdate("tool-1", " more");
    await flushAsyncWork();

    callbacks.onAutonomousToolEnd("tool-1", false);
    await flushAsyncWork();

    // Tool end edit should include the accumulated partial result.
    // safeEditMessage → bot.api.editMessageText(chatId, messageId, text, ...)
    const toolEndEdit = api.editMessageText.mock.calls.find(
      (call: any[]) => call[2]?.includes?.("partial output more"),
    );
    expect(toolEndEdit).toBeDefined();

    handler.stop();
    vi.useRealTimers();
  });

  it("sends tool error messages in errors-only verbosity mode", async () => {
    vi.useFakeTimers();
    const api = createMockApi();
    const bot = createMockBot(api);
    const piSession = createMockSession();

    const handler = createAutonomousHandler({
      bot,
      target: defaultTarget,
      piSession,
      toolVerbosity: "errors-only" as ToolVerbosity,
    });

    handler.start();
    const callbacks = (piSession as any).getAutonomousCallbacks();

    callbacks.onAutonomousStart();

    // Successful tool: no message in errors-only mode
    callbacks.onAutonomousToolStart("ls", "tool-ok");
    callbacks.onAutonomousToolEnd("tool-ok", false);

    // Errored tool: should send a message
    callbacks.onAutonomousToolStart("bash", "tool-err");
    callbacks.onAutonomousToolEnd("tool-err", true);

    await flushAsyncWork();

    // sendTextMessage → api.sendMessage(chatId, text, options)
    const errorCalls = api.sendMessage.mock.calls.filter(
      (call: any[]) => {
        const text = call[1] ?? "";
        return text.includes("❌") && text.includes("bash");
      },
    );
    expect(errorCalls.length).toBe(1);

    // No success tool messages
    const successCalls = api.sendMessage.mock.calls.filter(
      (call: any[]) => {
        const text = call[1] ?? "";
        return text.includes("✅") && text.includes("ls");
      },
    );
    expect(successCalls.length).toBe(0);

    handler.stop();
    vi.useRealTimers();
  });
});
