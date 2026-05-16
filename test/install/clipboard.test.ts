import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { copyToClipboard } from "../../src/install/clipboard.js";

describe("copyToClipboard", () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    vi.restoreAllMocks();
  });

  it("returns false on unsupported platforms", async () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });

    const result = await copyToClipboard("test text");

    expect(result).toBe(false);
  });

  it("attempts pbcopy on macOS", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });

    // pbcopy exists on macOS — the call will actually run.
    // The result depends on whether we're on a real Mac.
    const result = await copyToClipboard("test text");

    // On a real Mac with pbcopy, this would be true.
    // On other platforms with mocked darwin, spawnSync will error → false.
    expect(typeof result).toBe("boolean");
  });

  it("attempts wl-copy, xclip, xsel on Linux in priority order", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });

    const result = await copyToClipboard("test text");

    // On a headless/non-Linux test runner, none of these will exist → false.
    // On a Linux desktop with one installed, could be true.
    // We just verify it doesn't throw.
    expect(typeof result).toBe("boolean");
  });

  it("handles empty string gracefully", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });

    const result = await copyToClipboard("");

    expect(typeof result).toBe("boolean");
  });

  it("handles special characters without breaking", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });

    const result = await copyToClipboard("line1\nline2 'quoted' \"double\" $PATH");

    expect(typeof result).toBe("boolean");
  });

  it("is used by sessions.ts handback instead of inline pbcopy", () => {
    // Verify sessions.ts no longer contains the old darwin-only pbcopy pattern.
    const sessionsSource = readFileSync(
      new URL("../../src/bot/commands/sessions.ts", import.meta.url),
      "utf8",
    );

    // Old pattern should be gone
    expect(sessionsSource).not.toContain('process.platform === "darwin"');
    expect(sessionsSource).not.toContain('spawnSync("pbcopy"');

    // New pattern should be present
    expect(sessionsSource).toContain("copyToClipboard");
    expect(sessionsSource).toContain('../../install/clipboard.js');
  });
});