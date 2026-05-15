import { type Context } from "grammy";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

import { escapeHTML } from "../../format.js";
import type { PiSessionContext, PiSessionInfo, PiSessionService } from "../../pi-session.js";
import { renderFailedText, renderPrefixedError } from "../message-rendering.js";
import type { TextOptions } from "../telegram-transport.js";

const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh"]);

export function createModelCommandHandlers(deps: {
  getExistingSession: (target: PiSessionContext) => PiSessionService | undefined;
  getOrCreateSession: (target: PiSessionContext) => Promise<PiSessionService>;
  refreshChatScopedCommands: (target: PiSessionContext, piSession: PiSessionService) => Promise<void>;
  safeReply: (ctx: Context, text: string, options?: TextOptions, target?: PiSessionContext) => Promise<void>;
  surfaceStartupErrorDiagnostics: (ctx: Context, target: PiSessionContext, info: PiSessionInfo) => Promise<void>;
}) {
  const {
    getExistingSession,
    getOrCreateSession,
    refreshChatScopedCommands,
    safeReply,
    surfaceStartupErrorDiagnostics,
  } = deps;

  const handleModelCommand = async (ctx: Context, target: PiSessionContext, commandText?: string): Promise<void> => {
    const rawText = commandText ?? ("text" in (ctx.message ?? {}) ? (ctx.message as { text: string }).text : "");
    const arg = rawText.replace(/^\/model(?:@\w+)?\s*/, "").trim();

    if (!arg) {
      const message = "Usage: /model provider/model-id\nExample: /model opencode-go/deepseek-v4-flash\nAppend :thinking-level for thinking models (e.g. :high, :off).";
      await safeReply(ctx, escapeHTML(message), { fallbackText: message }, target);
      return;
    }

    const existing = getExistingSession(target);
    const hadActiveSession = existing?.hasActiveSession() === true;
    const piSession = await getOrCreateSession(target);

    if (!piSession.hasActiveSession()) {
      try {
        await piSession.newSession();
      } catch (error) {
        const failure = renderPrefixedError("Failed to create session", error);
        await safeReply(ctx, failure.text, {
          fallbackText: failure.fallbackText,
          parseMode: failure.parseMode,
        }, target);
        return;
      }
    }

    if (!hadActiveSession) {
      await surfaceStartupErrorDiagnostics(ctx, target, piSession.getInfo());
    }

    await refreshChatScopedCommands(target, piSession);

    const { modelPattern, thinkingLevel } = splitThinkingLevel(arg);
    const slashIndex = modelPattern.indexOf("/");
    if (slashIndex < 0) {
      const message = `Invalid model reference: ${arg}\nUse the format provider/model-id.\nExample: /model opencode-go/deepseek-v4-flash`;
      await safeReply(ctx, escapeHTML(message), { fallbackText: message }, target);
      return;
    }

    const provider = modelPattern.slice(0, slashIndex).trim();
    const modelId = modelPattern.slice(slashIndex + 1).trim();
    if (!provider || !modelId) {
      const message = `Invalid model reference: ${arg}\nUse the format provider/model-id.\nExample: /model opencode-go/deepseek-v4-flash`;
      await safeReply(ctx, escapeHTML(message), { fallbackText: message }, target);
      return;
    }

    try {
      const modelName = await piSession.setModel(provider, modelId, thinkingLevel);
      const html = `<b>Model switched to:</b> <code>${escapeHTML(modelName)}</code>`;
      const plainText = `Model switched to: ${modelName}`;
      await safeReply(ctx, html, { fallbackText: plainText }, target);
    } catch (error) {
      const failure = renderFailedText(error);
      await safeReply(ctx, failure.text, {
        fallbackText: failure.fallbackText,
        parseMode: failure.parseMode,
      }, target);
    }
  };

  return {
    handleModelCommand,
  };
}

function splitThinkingLevel(pattern: string): { modelPattern: string; thinkingLevel?: ThinkingLevel } {
  const colonIndex = pattern.lastIndexOf(":");
  if (colonIndex === -1) {
    return { modelPattern: pattern };
  }

  const suffix = pattern.slice(colonIndex + 1).trim();
  if (!THINKING_LEVELS.has(suffix as ThinkingLevel)) {
    return { modelPattern: pattern };
  }

  return {
    modelPattern: pattern.slice(0, colonIndex).trim(),
    thinkingLevel: suffix as ThinkingLevel,
  };
}
