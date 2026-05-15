import { vi } from "vitest";

import { createChatTaskRunner } from "../../src/bot/chat-task-runner.js";

const ROOT_CONTEXT = { chatId: 123 };
const TOPIC_CONTEXT = { chatId: 123, messageThreadId: 456 };

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("chat task runner", () => {
  it("starts one prompt task per context and releases the reservation after completion", async () => {
    const beginProcessing = vi.fn();
    const endProcessing = vi.fn();
    const onTaskError = vi.fn();
    let resolveTask!: () => void;

    const runner = createChatTaskRunner({
      beginProcessing,
      endProcessing,
      onTaskError,
    });

    const task = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveTask = resolve;
        }),
    );

    expect(runner.tryStartPrompt(ROOT_CONTEXT, "hello", task)).toBe("started");
    expect(beginProcessing).toHaveBeenCalledWith(ROOT_CONTEXT, "hello");
    expect(task).toHaveBeenCalledTimes(1);

    expect(runner.tryStartPrompt(ROOT_CONTEXT, "retry", vi.fn())).toBe("busy");

    resolveTask();
    await flushMicrotasks();

    expect(endProcessing).toHaveBeenCalledWith(ROOT_CONTEXT);
    expect(onTaskError).not.toHaveBeenCalled();
    expect(runner.tryStartPrompt(ROOT_CONTEXT, "retry", vi.fn().mockResolvedValue(undefined))).toBe("started");
  });

  it("releases the reservation and reports detached failures", async () => {
    const beginProcessing = vi.fn();
    const endProcessing = vi.fn();
    const onTaskError = vi.fn();
    let rejectTask!: (error: Error) => void;

    const runner = createChatTaskRunner({
      beginProcessing,
      endProcessing,
      onTaskError,
    });

    expect(
      runner.tryStartPrompt(
        ROOT_CONTEXT,
        "hello",
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectTask = reject;
          }),
      ),
    ).toBe("started");

    rejectTask(new Error("boom"));
    await flushMicrotasks();

    expect(onTaskError).toHaveBeenCalledWith(expect.any(Error), ROOT_CONTEXT, "hello");
    expect(onTaskError.mock.calls[0]?.[0]).toMatchObject({ message: "boom" });
    expect(endProcessing).toHaveBeenCalledWith(ROOT_CONTEXT);
    expect(runner.tryStartPrompt(ROOT_CONTEXT, "retry", vi.fn().mockResolvedValue(undefined))).toBe("started");
  });

  it("keeps topic threads independent within the same chat", async () => {
    const runner = createChatTaskRunner({
      beginProcessing: vi.fn(),
      endProcessing: vi.fn(),
      onTaskError: vi.fn(),
    });

    expect(runner.tryStartPrompt(ROOT_CONTEXT, "root", vi.fn().mockResolvedValue(undefined))).toBe("started");
    expect(runner.tryStartPrompt(TOPIC_CONTEXT, "topic", vi.fn().mockResolvedValue(undefined))).toBe("started");
  });
});
