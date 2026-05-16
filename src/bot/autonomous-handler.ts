import type { Bot, Context } from "grammy";

import {
  appendWithCap,
  buildStreamingPreview,
  formatToolSummaryLine,
  renderMarkdownChunkWithinLimit,
  renderToolEndMessage,
  renderToolStartMessage,
  splitMarkdownForTelegram,
  stripAnsiEscapes,
  TOOL_OUTPUT_PREVIEW_LIMIT,
  type RenderedChunk,
} from "./message-rendering.js";
import {
  safeEditMessage,
  sendChatAction,
  sendTextMessage,
} from "./telegram-transport.js";
import type { PiSessionContext, PiSessionService } from "../pi-session.js";
import type { ToolVerbosity } from "../config.js";

const AUTONOMOUS_TYPING_INTERVAL_MS = 4500;
const AUTONOMOUS_EDIT_DEBOUNCE_MS = 1500;

type ToolState = {
  toolName: string;
  partialResult: string;
  messageId?: number;
  finalStatus?: { text: string; fallbackText: string; parseMode?: "HTML" };
};

export interface AutonomousHandlerDeps {
  bot: Bot<Context>;
  target: PiSessionContext;
  piSession: PiSessionService;
  toolVerbosity: ToolVerbosity;
}

export function createAutonomousHandler(deps: AutonomousHandlerDeps): {
  start: () => void;
  stop: () => void;
} {
  const { bot, target, piSession, toolVerbosity } = deps;
  let typingInterval: NodeJS.Timeout | undefined;
  let accumulatedText = "";
  let responseMessageId: number | undefined;
  let responseMessagePromise: Promise<void> | undefined;
  let lastRenderedText = "";
  let lastEditAt = 0;
  let flushTimer: NodeJS.Timeout | undefined;
  let isFlushing = false;
  let flushPending = false;
  let finalized = false;
  const toolStates = new Map<string, ToolState>();
  const toolCounts = new Map<string, number>();

  const stopTyping = (): void => {
    if (typingInterval) {
      clearInterval(typingInterval);
      typingInterval = undefined;
    }
  };

  const clearFlushTimer = (): void => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
  };

  const ensureResponseMessage = async (): Promise<void> => {
    if (responseMessageId) {
      return;
    }
    if (responseMessagePromise) {
      await responseMessagePromise;
      return;
    }

    const preview = renderMarkdownChunkWithinLimit(buildStreamingPreview(accumulatedText));

    responseMessagePromise = (async () => {
      stopTyping();
      const message = await sendTextMessage(bot.api, target, preview.text, {
        parseMode: preview.parseMode,
        fallbackText: preview.fallbackText,
      });
      responseMessageId = message.message_id;
      lastRenderedText = preview.text;
      lastEditAt = Date.now();
    })();

    try {
      await responseMessagePromise;
    } finally {
      responseMessagePromise = undefined;
    }
  };

  const flushResponse = async (force = false): Promise<void> => {
    if (!accumulatedText) {
      return;
    }
    if (!responseMessageId) {
      await ensureResponseMessage();
      return;
    }
    if (isFlushing) {
      flushPending = true;
      return;
    }

    const now = Date.now();
    if (!force && now - lastEditAt < AUTONOMOUS_EDIT_DEBOUNCE_MS) {
      return;
    }

    const nextText = renderMarkdownChunkWithinLimit(buildStreamingPreview(accumulatedText));
    if (nextText.text === lastRenderedText) {
      return;
    }

    isFlushing = true;
    try {
      await safeEditMessage(bot, target, responseMessageId, nextText.text, {
        parseMode: nextText.parseMode,
        fallbackText: nextText.fallbackText,
      });
      lastRenderedText = nextText.text;
      lastEditAt = Date.now();
    } finally {
      isFlushing = false;
      if (flushPending) {
        flushPending = false;
        scheduleFlush();
      }
    }
  };

  const scheduleFlush = (): void => {
    if (flushTimer || finalized) {
      return;
    }

    const delay = Math.max(0, AUTONOMOUS_EDIT_DEBOUNCE_MS - (Date.now() - lastEditAt));
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      void flushResponse().catch((error) => {
        console.error("Failed to update autonomous Telegram response message", error);
      });
    }, delay);
  };

  const buildFinalResponseText = (text: string): string => {
    if (toolVerbosity !== "summary") {
      return text.trim();
    }

    const summaryLine = formatToolSummaryLine(toolCounts);
    const trimmedText = text.trim();
    if (!summaryLine) {
      return trimmedText;
    }

    return trimmedText ? `${trimmedText}\n\n${summaryLine}` : summaryLine;
  };

  const deliverRenderedChunks = async (chunks: RenderedChunk[]): Promise<void> => {
    if (chunks.length === 0) {
      return;
    }

    const [firstChunk, ...remainingChunks] = chunks;
    if (responseMessageId) {
      await safeEditMessage(bot, target, responseMessageId, firstChunk.text, {
        parseMode: firstChunk.parseMode,
        fallbackText: firstChunk.fallbackText,
      });
    } else {
      const message = await sendTextMessage(bot.api, target, firstChunk.text, {
        parseMode: firstChunk.parseMode,
        fallbackText: firstChunk.fallbackText,
      });
      responseMessageId = message.message_id;
    }

    for (const chunk of remainingChunks) {
      await sendTextMessage(bot.api, target, chunk.text, {
        parseMode: chunk.parseMode,
        fallbackText: chunk.fallbackText,
      });
    }
  };

  const finalizeResponse = async (): Promise<void> => {
    if (finalized) {
      return;
    }
    finalized = true;

    stopTyping();
    clearFlushTimer();

    if (responseMessagePromise) {
      try {
        await responseMessagePromise;
      } catch {
        // If the initial send failed, we will try sending the final response below.
      }
    }

    const finalText = buildFinalResponseText(accumulatedText);
    if (!finalText) {
      const html = "<b>✅ Done</b> (autonomous)";
      const plainText = "✅ Done (autonomous)";

      if (responseMessageId) {
        await safeEditMessage(bot, target, responseMessageId, html, { fallbackText: plainText });
      }
      return;
    }

    await deliverRenderedChunks(splitMarkdownForTelegram(finalText));
  };

  const onStart = (): void => {
    stopTyping();
    finalized = false;
    accumulatedText = "";
    responseMessageId = undefined;
    responseMessagePromise = undefined;
    lastRenderedText = "";
    lastEditAt = 0;
    toolStates.clear();
    toolCounts.clear();

    typingInterval = setInterval(() => {
      void sendChatAction(bot.api, target, "typing").catch(() => {});
    }, AUTONOMOUS_TYPING_INTERVAL_MS);
    void sendChatAction(bot.api, target, "typing").catch(() => {});
  };

  const onTextDelta = (delta: string): void => {
    accumulatedText += delta;
    if (!responseMessageId) {
      void ensureResponseMessage()
        .then(() => {
          scheduleFlush();
        })
        .catch((error) => {
          console.error("Failed to send autonomous Telegram response message", error);
        });
      return;
    }

    scheduleFlush();
  };

  const onToolStart = (toolName: string, toolCallId: string): void => {
    if (toolVerbosity === "summary") {
      toolCounts.set(toolName, (toolCounts.get(toolName) ?? 0) + 1);
      return;
    }

    if (toolVerbosity === "none") {
      return;
    }

    const state: ToolState = { toolName, partialResult: "" };
    toolStates.set(toolCallId, state);

    if (toolVerbosity !== "all") {
      // errors-only mode: defer message until tool end (only on error)
      return;
    }

    const messageText = renderToolStartMessage(toolName);

    void (async () => {
      const message = await sendTextMessage(bot.api, target, messageText.text, {
        parseMode: messageText.parseMode,
        fallbackText: messageText.fallbackText,
      });
      const currentState = toolStates.get(toolCallId);
      if (!currentState) {
        return;
      }

      currentState.messageId = message.message_id;
      if (currentState.finalStatus) {
        await safeEditMessage(bot, target, currentState.messageId, currentState.finalStatus.text, {
          parseMode: currentState.finalStatus.parseMode,
          fallbackText: currentState.finalStatus.fallbackText,
        });
      }
    })().catch((error) => {
      console.error(`Failed to send autonomous tool start message for ${toolName}`, error);
    });
  };

  const onToolUpdate = (toolCallId: string, partialResult: string): void => {
    if (toolVerbosity === "none" || toolVerbosity === "summary") {
      return;
    }

    const state = toolStates.get(toolCallId);
    if (!state || !partialResult) {
      return;
    }

    state.partialResult = appendWithCap(state.partialResult, stripAnsiEscapes(partialResult), TOOL_OUTPUT_PREVIEW_LIMIT);
  };

  const onToolEnd = (toolCallId: string, isError: boolean): void => {
    if (toolVerbosity === "none" || toolVerbosity === "summary") {
      return;
    }

    const state = toolStates.get(toolCallId);
    if (!state) {
      return;
    }

    state.partialResult = stripAnsiEscapes(state.partialResult);
    state.finalStatus = renderToolEndMessage(state.toolName, state.partialResult, isError);

    if (toolVerbosity === "errors-only") {
      if (!isError) {
        return;
      }

      void sendTextMessage(bot.api, target, state.finalStatus.text, {
        parseMode: state.finalStatus.parseMode,
        fallbackText: state.finalStatus.fallbackText,
      }).catch((error) => {
        console.error(`Failed to send autonomous tool error message for ${state.toolName}`, error);
      });
      return;
    }

    // all verbosity mode: update the existing tool start message
    if (!state.messageId) {
      // The tool start message may still be in flight; finalStatus will be
      // picked up by the sendTextMessage callback above.
      return;
    }

    void safeEditMessage(bot, target, state.messageId, state.finalStatus.text, {
      parseMode: state.finalStatus.parseMode,
      fallbackText: state.finalStatus.fallbackText,
    }).catch((error) => {
      console.error(`Failed to update autonomous tool message for ${state.toolName}`, error);
    });
  };

  const onEnd = (): void => {
    void finalizeResponse().catch((error) => {
      console.error("Failed to finalize autonomous Telegram response", error);
    });
  };

  const start = (): void => {
    piSession.subscribeAutonomous({
      onAutonomousStart: onStart,
      onAutonomousTextDelta: onTextDelta,
      onAutonomousToolStart: onToolStart,
      onAutonomousToolUpdate: onToolUpdate,
      onAutonomousToolEnd: onToolEnd,
      onAutonomousEnd: onEnd,
    });
  };

  const stop = (): void => {
    stopTyping();
    clearFlushTimer();
    finalized = true;
  };

  return { start, stop };
}