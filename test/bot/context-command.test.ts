import { vi } from "vitest";

import type { PiSessionContext, PiSessionService } from "../../src/pi-session.js";
import { createContextCommandHandlers } from "../../src/bot/commands/context.js";
import { renderContextUsageHTML, renderContextUsagePlain } from "../../src/bot/message-rendering.js";

describe("context command", () => {
  describe("renderContextUsagePlain", () => {
    it("renders context usage with known tokens", () => {
      const result = renderContextUsagePlain({
        tokens: 4500,
        contextWindow: 128000,
        percent: 3.52,
      });
      expect(result).toContain("4,500");
      expect(result).toContain("128,000");
      expect(result).toContain("3.52%");
    });

    it("renders context usage with null tokens (unknown)", () => {
      const result = renderContextUsagePlain({
        tokens: null,
        contextWindow: 128000,
        percent: null,
      });
      expect(result).toContain("128,000");
      expect(result).toContain("unknown");
    });
  });

  describe("renderContextUsageHTML", () => {
    it("renders context usage with known tokens", () => {
      const result = renderContextUsageHTML({
        tokens: 4500,
        contextWindow: 128000,
        percent: 3.52,
      });
      expect(result).toContain("4,500");
      expect(result).toContain("128,000");
      expect(result).toContain("3.52%");
    });

    it("renders context usage with null tokens (unknown)", () => {
      const result = renderContextUsageHTML({
        tokens: null,
        contextWindow: 128000,
        percent: null,
      });
      expect(result).toContain("128,000");
      expect(result).toContain("unknown");
    });
  });

  describe("handleContextCommand", () => {
    const target: PiSessionContext = { chatId: 456 };

    function makeDeps(overrides: Partial<PiSessionService> = {}) {
      const getExistingSession = vi.fn().mockReturnValue({
        hasActiveSession: vi.fn().mockReturnValue(true),
        getInfo: vi.fn().mockReturnValue({
          sessionId: "test-session",
          workspace: "/workspace",
        }),
        getContextUsage: vi.fn().mockReturnValue({
          tokens: 4500,
          contextWindow: 128000,
          percent: 3.52,
        }),
        getSessionStats: vi.fn().mockReturnValue({
          userMessages: 5,
          assistantMessages: 5,
          toolCalls: 12,
          toolResults: 12,
          totalMessages: 20,
          tokens: {
            input: 40000,
            output: 8000,
            cacheRead: 2000,
            cacheWrite: 1000,
            total: 50000,
          },
          cost: 0.05,
          contextUsage: {
            tokens: 4500,
            contextWindow: 128000,
            percent: 3.52,
          },
          sessionFile: "/tmp/session.jsonl",
          sessionId: "test-session",
        }),
        ...overrides,
      } as Partial<PiSessionService>);

      const safeReply = vi.fn().mockResolvedValue(undefined);

      return { getExistingSession, safeReply };
    }

    it("shows context usage when session exists", async () => {
      const { getExistingSession, safeReply } = makeDeps();
      const { handleContextCommand } = createContextCommandHandlers({
        getExistingSession,
        safeReply,
      });

      const ctx = {
        message: { text: "/context" },
      } as any;

      await handleContextCommand(ctx, target);

      expect(safeReply).toHaveBeenCalledTimes(1);
      const html = safeReply.mock.calls[0][1];
      const plainText = safeReply.mock.calls[0][2]?.fallbackText;

      expect(html).toContain("Context Usage");
      expect(html).toContain("4,500");
      expect(html).toContain("128,000");
      expect(plainText).toContain("Context Usage");
      expect(plainText).toContain("4,500");
    });

    it("shows 'no active session' when session has no active session", async () => {
      const { safeReply } = makeDeps({
        hasActiveSession: vi.fn().mockReturnValue(false),
        getInfo: vi.fn().mockReturnValue({
          sessionId: "test-session",
          workspace: "/workspace",
        }),
        getContextUsage: vi.fn().mockReturnValue(undefined),
        getSessionStats: vi.fn().mockReturnValue(undefined),
      });
      const getExistingSession = vi.fn().mockReturnValue({
        hasActiveSession: vi.fn().mockReturnValue(false),
      } as Partial<PiSessionService>);
      const { handleContextCommand } = createContextCommandHandlers({
        getExistingSession,
        safeReply,
      });

      const ctx = {
        message: { text: "/context" },
      } as any;

      await handleContextCommand(ctx, target);

      expect(safeReply).toHaveBeenCalledTimes(1);
      const html = safeReply.mock.calls[0][1];
      expect(html).toContain("No active session");
    });

    it("shows context usage with unknown tokens when just started", async () => {
      const { safeReply } = makeDeps({
        getInfo: vi.fn().mockReturnValue({
          sessionId: "test-session",
          workspace: "/workspace",
        }),
        getContextUsage: vi.fn().mockReturnValue({
          tokens: null,
          contextWindow: 128000,
          percent: null,
        }),
        getSessionStats: vi.fn().mockReturnValue({
          userMessages: 1,
          assistantMessages: 0,
          toolCalls: 0,
          toolResults: 0,
          totalMessages: 1,
          tokens: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
          cost: 0,
          contextUsage: {
            tokens: null,
            contextWindow: 128000,
            percent: null,
          },
          sessionFile: undefined,
          sessionId: "test-session",
        }),
      });
      const { getExistingSession } = makeDeps({
        getInfo: vi.fn().mockReturnValue({
          sessionId: "test-session",
          workspace: "/workspace",
        }),
        getContextUsage: vi.fn().mockReturnValue({
          tokens: null,
          contextWindow: 128000,
          percent: null,
        }),
        getSessionStats: vi.fn().mockReturnValue({
          userMessages: 1,
          assistantMessages: 0,
          toolCalls: 0,
          toolResults: 0,
          totalMessages: 1,
          tokens: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
          cost: 0,
          contextUsage: {
            tokens: null,
            contextWindow: 128000,
            percent: null,
          },
          sessionFile: undefined,
          sessionId: "test-session",
        }),
      });
      const handlers = createContextCommandHandlers({
        getExistingSession,
        safeReply,
      });

      const ctx = {
        message: { text: "/context" },
      } as any;

      await handlers.handleContextCommand(ctx, target);

      expect(safeReply).toHaveBeenCalledTimes(1);
      const html = safeReply.mock.calls[0][1];
      expect(html).toContain("unknown");
    });
  });
});
