import { createExtensionDialogManager } from "../../src/bot/extension-dialogs.js";
import { renderDialogPanel } from "../../src/bot/message-rendering.js";
import type { PiSessionContext } from "../../src/pi-session.js";

describe("extension dialog manager", () => {
  const target: PiSessionContext = { chatId: 123 };
  const topicTarget: PiSessionContext = { chatId: 123, messageThreadId: 77 };
  const rootTarget: PiSessionContext = { chatId: 123 };

  function createManager() {
    const sendTextMessage = vi.fn().mockResolvedValue({ message_id: 1 });
    const editMessage = vi.fn().mockResolvedValue(undefined);
    const manager = createExtensionDialogManager({
      getContextKey: (ctx) => `${String(ctx.chatId)}::${ctx.messageThreadId ?? "root"}`,
      sendTextMessage,
      editMessage,
      defaultTimeoutMs: 50,
    });

    return { manager, sendTextMessage, editMessage };
  }

  it("resolves select promises immediately without waiting for the message edit", async () => {
    const { manager, sendTextMessage, editMessage } = createManager();

    const pendingChoice = manager.openSelect(target, "Pick one", ["Alpha", "Beta"]);
    await Promise.resolve();

    const opened = renderDialogPanel("Pick one", ["2 options available.", "Use the buttons below."], "🧭");
    expect(sendTextMessage).toHaveBeenCalledWith(target, opened.text, expect.objectContaining({
      fallbackText: opened.fallbackText,
      parseMode: "HTML",
    }));

    const result = await manager.resolveSelect(target, "1", 1, 1);
    expect(result.callbackText).toBe("Selected Beta");
    expect(editMessage).not.toHaveBeenCalled();

    // Promise resolves immediately — before the message edit fires
    await expect(pendingChoice).resolves.toBe("Beta");

    await result.afterAnswer?.();

    const selected = renderDialogPanel("Pick one", ["Selected: Beta"], "✅");
    expect(editMessage).toHaveBeenCalledWith(
      target,
      1,
      selected.text,
      expect.objectContaining({ fallbackText: selected.fallbackText, parseMode: "HTML" }),
    );
  });

  it("resolves select dialogs by dialogId when the callback target loses its thread context", async () => {
    const { manager, editMessage } = createManager();

    const pendingChoice = manager.openSelect(topicTarget, "Pick one", ["Alpha", "Beta"]);
    await Promise.resolve();

    const result = await manager.resolveSelect(rootTarget, "1", 1, 1);
    expect(result.callbackText).toBe("Selected Beta");

    // Promise resolves immediately
    await expect(pendingChoice).resolves.toBe("Beta");

    await result.afterAnswer?.();

    const selected = renderDialogPanel("Pick one", ["Selected: Beta"], "✅");
    expect(editMessage).toHaveBeenCalledWith(
      rootTarget,
      1,
      selected.text,
      expect.objectContaining({ fallbackText: selected.fallbackText, parseMode: "HTML" }),
    );
  });

  it("times out dialogs and finalizes them in Telegram", async () => {
    const { manager, editMessage } = createManager();

    const pendingInput = manager.openInput(target, "Name", "Your name", { timeout: 5 });
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));

    await expect(pendingInput).resolves.toBeUndefined();
    const timedOut = renderDialogPanel("Name", ["Dialog timed out."], "⏰");
    expect(editMessage).toHaveBeenCalledWith(
      target,
      1,
      timedOut.text,
      expect.objectContaining({ fallbackText: timedOut.fallbackText, parseMode: "HTML" }),
    );
  });

  it("consumes input replies and can cancel pending dialogs", async () => {
    const { manager, editMessage } = createManager();

    expect(await manager.consumeInput(target, "Bene")).toBe(false);

    const pendingInput = manager.openInput(target, "Name", "Your name");
    await Promise.resolve();
    expect(manager.getPendingKind(target)).toBe("input");

    await expect(manager.consumeInput(target, "Bene")).resolves.toBe(true);
    await expect(pendingInput).resolves.toBe("Bene");
    const received = renderDialogPanel("Name", ["Received: Bene"], "✅");
    expect(editMessage).toHaveBeenCalledWith(
      target,
      1,
      received.text,
      expect.objectContaining({ fallbackText: received.fallbackText, parseMode: "HTML" }),
    );

    const pendingConfirm = manager.openConfirm(target, "Confirm deploy", "Ship it?");
    await Promise.resolve();
    await expect(manager.cancelPending(target)).resolves.toBe(true);
    await expect(pendingConfirm).resolves.toBe(false);
    const cancelled = renderDialogPanel("Confirm deploy", ["Dialog cancelled."], "⛔");
    expect(editMessage).toHaveBeenLastCalledWith(
      target,
      1,
      cancelled.text,
      expect.objectContaining({ fallbackText: cancelled.fallbackText, parseMode: "HTML" }),
    );
  });

  it("resolves confirm and cancel promises immediately before the message edit", async () => {
    const { manager, editMessage } = createManager();

    // Confirm "Yes" path
    const pendingConfirm = manager.openConfirm(target, "Confirm deploy", "Ship it?");
    await Promise.resolve();

    const confirmResult = await manager.resolveConfirm(target, "1", 1, true);
    expect(confirmResult.callbackText).toBe("Confirmed");
    expect(editMessage).not.toHaveBeenCalled();

    // Promise resolves immediately — before the message edit fires
    await expect(pendingConfirm).resolves.toBe(true);

    await confirmResult.afterAnswer?.();

    const confirmed = renderDialogPanel("Confirm deploy", ["Confirmed."], "✅");
    expect(editMessage).toHaveBeenCalledWith(
      target,
      1,
      confirmed.text,
      expect.objectContaining({ fallbackText: confirmed.fallbackText, parseMode: "HTML" }),
    );

    // Confirm "No" path
    const pendingDeny = manager.openConfirm(target, "Permission Required", "Allow bash?");
    await Promise.resolve();

    const denyResult = await manager.resolveConfirm(target, "2", 1, false);
    expect(denyResult.callbackText).toBe("Cancelled");

    // Promise resolves immediately with false
    await expect(pendingDeny).resolves.toBe(false);

    await denyResult.afterAnswer?.();

    const cancelledPanel = renderDialogPanel("Permission Required", ["Cancelled."], "⛔");
    expect(editMessage).toHaveBeenCalledWith(
      target,
      1,
      cancelledPanel.text,
      expect.objectContaining({ fallbackText: cancelledPanel.fallbackText, parseMode: "HTML" }),
    );

    // Cancel path via resolveCancel
    const pendingSelect = manager.openSelect(target, "Pick one", ["Alpha"]);
    await Promise.resolve();
    const cancelResult = await manager.resolveCancel(target, "3", 1);
    expect(cancelResult.callbackText).toBe("Cancelled");
    await cancelResult.afterAnswer?.();
    await expect(pendingSelect).resolves.toBeUndefined();
  });

  it("resolves confirm and cancel callbacks by dialogId even when callback message IDs are missing", async () => {
    const { manager, editMessage } = createManager();

    const pendingConfirm = manager.openConfirm(topicTarget, "Confirm deploy", "Ship it?");
    await Promise.resolve();

    const confirmResult = await manager.resolveConfirm(rootTarget, "1", undefined, true);
    expect(confirmResult.callbackText).toBe("Confirmed");

    // Promise resolves immediately
    await expect(pendingConfirm).resolves.toBe(true);

    await confirmResult.afterAnswer?.();
    const confirmed = renderDialogPanel("Confirm deploy", ["Confirmed."], "✅");
    expect(editMessage).toHaveBeenCalledWith(
      rootTarget,
      1,
      confirmed.text,
      expect.objectContaining({ fallbackText: confirmed.fallbackText, parseMode: "HTML" }),
    );

    editMessage.mockClear();

    const pendingInput = manager.openInput(topicTarget, "Name", "Your name");
    await Promise.resolve();

    const cancelResult = await manager.resolveCancel(rootTarget, "2", undefined);
    expect(cancelResult.callbackText).toBe("Cancelled");

    // Promise resolves immediately
    await expect(pendingInput).resolves.toBeUndefined();

    await cancelResult.afterAnswer?.();
    const cancelled = renderDialogPanel("Name", ["Dialog cancelled."], "⛔");
    expect(editMessage).toHaveBeenCalledWith(
      rootTarget,
      1,
      cancelled.text,
      expect.objectContaining({ fallbackText: cancelled.fallbackText, parseMode: "HTML" }),
    );
  });

  it("still resolves extension promises when finalizing the dialog message fails", async () => {
    const sendTextMessage = vi.fn().mockResolvedValue({ message_id: 1 });
    const editMessage = vi.fn().mockRejectedValue(new Error("telegram down"));
    const manager = createExtensionDialogManager({
      getContextKey: (ctx) => `${String(ctx.chatId)}::${ctx.messageThreadId ?? "root"}`,
      sendTextMessage,
      editMessage,
      defaultTimeoutMs: 50,
    });

    const pendingChoice = manager.openSelect(target, "Pick one", ["Alpha"]);
    await Promise.resolve();

    const result = await manager.resolveSelect(target, "1", 1, 0);

    // Promise resolves immediately even though finalizePending will throw
    await expect(pendingChoice).resolves.toBe("Alpha");

    // The message edit still fails as a background side effect
    await expect(result.afterAnswer?.()).rejects.toThrow("telegram down");
  });
});
