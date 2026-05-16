import { afterEach, describe, expect, it } from "vitest";

import { getPlatformInstallHint } from "../../src/install/platform.js";

describe("getPlatformInstallHint", () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });

  it("returns brew install on macOS", () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });

    const hint = getPlatformInstallHint("ffmpeg");

    expect(hint).toBe("brew install ffmpeg");
  });

  it("returns a Linux package manager command on Linux", () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });

    const hint = getPlatformInstallHint("ffmpeg");

    // On any system, the hint should not contain "brew"
    expect(hint).not.toContain("brew");

    // It should mention installing ffmpeg
    expect(hint.toLowerCase()).toContain("ffmpeg");
    // Either contains "install" or "pacman -s"
    const hasInstall = hint.toLowerCase().includes("install") || hint.toLowerCase().includes("pacman -s");
    expect(hasInstall).toBe(true);

    // Should be one of: apt, dnf, pacman, or generic fallback
    const isApt = hint.includes("sudo apt install");
    const isDnf = hint.includes("sudo dnf install");
    const isPacman = hint.includes("sudo pacman -S");
    const isGeneric = hint.includes("using your package manager");
    expect(isApt || isDnf || isPacman || isGeneric).toBe(true);
  });

  it("returns generic hint on unsupported platforms", () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });

    const hint = getPlatformInstallHint("git");

    expect(hint).toContain("git");
    expect(hint).toContain("package manager");
    expect(hint).not.toContain("brew");
    expect(hint).not.toContain("sudo");
  });

  it("works for different package names besides ffmpeg", () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });

    expect(getPlatformInstallHint("node")).toBe("brew install node");
    expect(getPlatformInstallHint("python3")).toBe("brew install python3");
  });

  it("returns a string (never throws)", () => {
    // On any platform, the function should never throw
    for (const platform of ["darwin", "linux", "win32", "freebsd"]) {
      Object.defineProperty(process, "platform", { value: platform, configurable: true });
      const hint = getPlatformInstallHint("test-pkg");
      expect(typeof hint).toBe("string");
      expect(hint.length).toBeGreaterThan(0);
    }
  });
});