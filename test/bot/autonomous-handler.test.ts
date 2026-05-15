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

    // Advance timers to allow the async send to complete
    await vi.runAllTimersAsync();

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

    await vi.runAllTimersAsync();

    callbacks.onAutonomousEnd();
    await vi.runAllTimersAsync();

    // Should have sent at least one message (the initial or final)
    expect(api.sendMessage.mock.calls.length + api.editMessageText.mock.calls.length).toBeGreaterThanOrEqual(1);
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
    await vi.runAllTimersAsync();
    callbacks.onAutonomousEnd();
    await vi.runAllTimersAsync();

    // The final message should include tool summary
    const allCalls = [
      ...api.sendMessage.mock.calls,
      ...api.editMessageText.mock.calls,
    ];
    const messages = allCalls.map((call: any[]) => call[1]);

    // In summary mode, the final text should include tool summary
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
    await vi.runAllTimersAsync();

    // Tool start sends a separate message
    expect(api.sendMessage.mock.calls.length).toBeGreaterThanOrEqual(1);

    callbacks.onAutonomousToolEnd("tool-1", false);
    callbacks.onAutonomousEnd();
    await vi.runAllTimersAsync();

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
    await vi.runAllTimersAsync();
    callbacks.onAutonomousEnd();
    await vi.runAllTimersAsync();

    // No tool messages should be sent
    const toolMessages = api.sendMessage.mock.calls.filter(
      (call: any[]) => call[1]?.includes?.("Running:") || call[1]?.includes?.("✅"),
    );
    expect(toolMessages.length).toBe(0);
    handler.stop();
    vi.useRealTimers();
  });
});