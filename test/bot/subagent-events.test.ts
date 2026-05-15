import { describe, expect, it, vi } from "vitest";

import {
  formatControlEventNotice,
  formatNotifyMessage,
  type ControlEventPayload,
  type SubagentNotifyPayload,
} from "../../src/bot/subagent-events.js";

describe("formatControlEventNotice", () => {
  it("formats a needs_attention event with agent name", () => {
    const event: ControlEventPayload = {
      type: "needs_attention",
      runId: "run-abc123",
      agent: "code-analysis",
      message: "needs attention",
    };

    const result = formatControlEventNotice(event);
    expect(result).toContain("Needs attention");
    expect(result).toContain("<code>code-analysis</code>");
  });

  it("formats a long-running event with elapsed time", () => {
    const event: ControlEventPayload = {
      type: "active_long_running",
      runId: "run-xyz",
      agent: "scout",
      message: "still running",
      elapsedMs: 125000,
    };

    const result = formatControlEventNotice(event);
    expect(result).toContain("Long-running");
    expect(result).toContain("<code>scout</code>");
    expect(result).toContain("125s");
  });

  it("includes tool info and failure summary when present", () => {
    const event: ControlEventPayload = {
      type: "needs_attention",
      runId: "run-fail",
      agent: "builder",
      message: "needs attention",
      currentTool: "bash",
      currentToolDurationMs: 45000,
      recentFailureSummary: "exit code 1",
      turns: 5,
      tokens: 12000,
      toolCount: 8,
    };

    const result = formatControlEventNotice(event);
    expect(result).toContain("<code>bash</code>");
    expect(result).toContain("45s");
    expect(result).toContain("exit code 1");
    expect(result).toContain("5 turns");
    expect(result).toContain("12000 tokens");
    expect(result).toContain("8 tools");
  });
});

describe("formatNotifyMessage", () => {
  it("formats a completed notification", () => {
    const payload: SubagentNotifyPayload = {
      agent: "coder",
      status: "completed",
      resultPreview: "All tests pass.",
    };

    const result = formatNotifyMessage(payload);
    expect(result).toContain("✅");
    expect(result).toContain("<b>coder</b>");
    expect(result).toContain("completed");
    expect(result).toContain("All tests pass.");
  });

  it("formats a failed notification with duration and task info", () => {
    const payload: SubagentNotifyPayload = {
      agent: "reviewer",
      status: "failed",
      resultPreview: "Something went wrong",
      taskInfo: "(1/2)",
      durationMs: 30000,
    };

    const result = formatNotifyMessage(payload);
    expect(result).toContain("❌");
    expect(result).toContain("<b>reviewer</b>");
    expect(result).toContain("failed");
    expect(result).toContain("(1/2)");
    expect(result).toContain("30s");
  });

  it("formats a paused notification", () => {
    const payload: SubagentNotifyPayload = {
      agent: "helper",
      status: "paused",
      resultPreview: "Paused after interrupt.",
    };

    const result = formatNotifyMessage(payload);
    expect(result).toContain("⏸️");
    expect(result).toContain("paused");
  });

  it("truncates long result previews", () => {
    const payload: SubagentNotifyPayload = {
      agent: "worker",
      status: "completed",
      resultPreview: "x".repeat(500),
    };

    const result = formatNotifyMessage(payload);
    expect(result).toContain("…");
  });
});