import type { PiSessionContext } from "../pi-session.js";
import { getPiSessionContextKey } from "../pi-session.js";

export interface ChatTaskRunner {
  tryStartPrompt(
    target: PiSessionContext,
    promptText: string,
    task: () => Promise<void>,
  ): "started" | "busy";
}

export function createChatTaskRunner(deps: {
  beginProcessing: (target: PiSessionContext, promptText: string) => void;
  endProcessing: (target: PiSessionContext) => void;
  onTaskError: (error: unknown, target: PiSessionContext, promptText: string) => void;
}): ChatTaskRunner {
  const runningContexts = new Set<string>();
  const pendingTasks = new Set<Promise<void>>();

  return {
    tryStartPrompt(target, promptText, task) {
      const contextKey = getPiSessionContextKey(target);
      if (runningContexts.has(contextKey)) {
        return "busy";
      }

      runningContexts.add(contextKey);
      deps.beginProcessing(target, promptText);

      let taskPromise!: Promise<void>;
      taskPromise = (async () => {
        try {
          await task();
        } catch (error) {
          deps.onTaskError(error, target, promptText);
        } finally {
          runningContexts.delete(contextKey);
          deps.endProcessing(target);
          pendingTasks.delete(taskPromise);
        }
      })();

      pendingTasks.add(taskPromise);
      return "started";
    },
  };
}
