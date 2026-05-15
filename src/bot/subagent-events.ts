/**
 * Subagent event notifications for TelePi.
 *
 * The `subagent` extension fires control and completion events on
 * `pi.events` (the per-session ExtensionAPI event bus). TelePi does
 * not have direct access to `pi.events`, so it relies on the
 * autonomous turn handler (persistent AgentSession.subscribe) to
 * stream the LLM's response when `triggerTurn: true` fires.
 *
 * This module provides auxiliary helpers for rendering control-event
 * notices if they become available through the session in the future.
 */

import { escapeHTML } from "../format.js";

/**
 * Render a subagent control notice for Telegram.
 * The payload shape mirrors pi-subagents' ControlEvent without a hard dependency.
 */
export interface ControlEventPayload {
  type: string;
  runId: string;
  agent: string;
  message: string;
  reason?: string;
  elapsedMs?: number;
  turns?: number;
  tokens?: number;
  toolCount?: number;
  currentTool?: string;
  currentToolDurationMs?: number;
  recentFailureSummary?: string;
  index?: number;
}

export function formatControlEventNotice(event: ControlEventPayload): string {
  const statusLabel = event.type === "active_long_running"
    ? "⏳ Long-running"
    : "⚠️ Needs attention";

  const lines: string[] = [
    `<b>${statusLabel}</b> — <code>${escapeHTML(event.agent)}</code>`,
  ];

  if (event.elapsedMs !== undefined) {
    const elapsedSeconds = Math.floor(event.elapsedMs / 1000);
    lines.push(`<i>Elapsed: ${elapsedSeconds}s</i>`);
  }

  if (event.currentTool) {
    const toolDuration = event.currentToolDurationMs !== undefined
      ? ` (${Math.floor(event.currentToolDurationMs / 1000)}s)`
      : "";
    lines.push(`Tool: <code>${escapeHTML(event.currentTool)}</code>${toolDuration}`);
  }

  if (event.recentFailureSummary) {
    lines.push(`Recent failures: ${escapeHTML(event.recentFailureSummary)}`);
  }

  const facts: string[] = [];
  if (event.turns !== undefined) facts.push(`${event.turns} turns`);
  if (event.tokens !== undefined) facts.push(`${event.tokens} tokens`);
  if (event.toolCount !== undefined) facts.push(`${event.toolCount} tools`);
  if (facts.length > 0) lines.push(facts.join(" · "));

  return lines.join("\n");
}

/**
 * Render a subagent async-completion notice for Telegram.
 */
export interface SubagentNotifyPayload {
  agent: string;
  status: "completed" | "failed" | "paused";
  resultPreview: string;
  taskInfo?: string;
  durationMs?: number;
  sessionLabel?: string;
  sessionValue?: string;
}

export function formatNotifyMessage(payload: SubagentNotifyPayload): string {
  const icon = payload.status === "completed"
    ? "✅"
    : payload.status === "paused"
      ? "⏸️"
      : "❌";

  const parts: string[] = [];
  if (payload.taskInfo) parts.push(payload.taskInfo);
  if (payload.durationMs !== undefined) {
    const elapsedSeconds = Math.floor(payload.durationMs / 1000);
    parts.push(`${elapsedSeconds}s`);
  }

  const detail = parts.length > 0 ? ` (${parts.join(" · ")})` : "";
  const preview = payload.resultPreview.length > 400
    ? `${payload.resultPreview.slice(0, 400)}…`
    : payload.resultPreview;

  return [
    `${icon} <b>${escapeHTML(payload.agent)}</b> ${payload.status}${detail}`,
    escapeHTML(preview),
  ].join("\n");
}