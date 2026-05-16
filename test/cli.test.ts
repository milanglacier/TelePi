import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  startBot: vi.fn().mockResolvedValue(undefined),
  setupTelePi: vi.fn().mockResolvedValue({
    context: {
      platform: "darwin" as const,
      version: "1.2.3",
      configPath: "/tmp/config.env",
      launchAgentPath: "/tmp/com.telepi.plist",
      extensionDestinationPath: "/tmp/telepi-handoff.ts",
    },
    configCreated: true,
    configUpdated: false,
    unitUpdated: true,
    launchAgentUpdated: true,
    extensionInstalledAs: "symlink" as const,
    serviceActions: ["bootout", "bootstrap"],
    launchdActions: ["bootout", "bootstrap"],
    serviceWarning: undefined,
    launchdWarning: undefined,
  }),
  getTelePiStatus: vi.fn().mockReturnValue({
    version: "1.2.3",
    resolvedConfigPath: "/tmp/config.env",
    configExists: true,
    configSource: "installed-default",
    service: {
      unitExists: true,
      plistExists: true,
      loaded: true,
      state: "running",
      pid: 123,
      detail: "loaded",
      error: undefined,
    },
    launchAgent: {
      unitExists: true,
      plistExists: true,
      loaded: true,
      state: "running",
      pid: 123,
      detail: "loaded",
      error: undefined,
    },
    extension: {
      mode: "symlink" as const,
      detail: "installed",
      targetPath: "/tmp/telepi-handoff.ts",
    },
  }),
  resolveTelePiInstallContext: vi.fn().mockReturnValue({ version: "1.2.3", platform: "darwin" }),
}));

vi.mock("../src/index.js", () => ({ startBot: mockState.startBot }));
vi.mock("../src/install.js", () => ({
  setupTelePi: mockState.setupTelePi,
  getTelePiStatus: mockState.getTelePiStatus,
  resolveTelePiInstallContext: mockState.resolveTelePiInstallContext,
}));

import { ensureNoArguments, main, runSetupCommand, runStatusCommand } from "../src/cli.js";

describe("telepi CLI", () => {
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

  beforeEach(() => {
    mockState.startBot.mockClear();
    mockState.setupTelePi.mockClear();
    mockState.getTelePiStatus.mockClear();
    mockState.resolveTelePiInstallContext.mockClear();
    logSpy.mockClear();
    warnSpy.mockClear();
  });

  it("starts the bot for the default and explicit start commands", async () => {
    await main([]);
    await main(["start"]);

    expect(mockState.startBot).toHaveBeenCalledTimes(2);
  });

  it("runs setup with either zero or three args", async () => {
    await runSetupCommand([]);
    await runSetupCommand(["token", "1,2", "/workspace"]);

    expect(mockState.setupTelePi).toHaveBeenNthCalledWith(1, expect.any(String), {
      telegramBotToken: undefined,
      telegramAllowedUserIds: undefined,
      workspace: undefined,
    });
    expect(mockState.setupTelePi).toHaveBeenNthCalledWith(2, expect.any(String), {
      telegramBotToken: "token",
      telegramAllowedUserIds: "1,2",
      workspace: "/workspace",
    });
    expect(logSpy).toHaveBeenCalledWith("TelePi 1.2.3");
    expect(logSpy).toHaveBeenCalledWith("launchd: bootout -> bootstrap");
  });

  it("prints status and version/help output", async () => {
    runStatusCommand();
    await main(["version"]);
    await main(["help"]);

    expect(mockState.getTelePiStatus).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls.some((call) => String(call[0]).includes("Config path:"))).toBe(true);
    expect(logSpy.mock.calls.some((call) => String(call[0]).includes("TelePi CLI"))).toBe(true);
  });

  it("uses systemd labels in status output on Linux", () => {
    mockState.resolveTelePiInstallContext.mockReturnValue({ version: "1.2.3", platform: "linux" });
    mockState.getTelePiStatus.mockReturnValue({
      version: "1.2.3",
      resolvedConfigPath: "/tmp/config.env",
      configExists: true,
      configSource: "service-env",
      service: {
        unitExists: true,
        plistExists: false,
        loaded: true,
        state: "active",
        pid: 9999,
        detail: "loaded",
        error: undefined,
      },
      launchAgent: {
        unitExists: true,
        plistExists: false,
        loaded: true,
        state: "active",
        pid: 9999,
        detail: "loaded",
        error: undefined,
      },
      extension: {
        mode: "symlink" as const,
        detail: "symlinked",
        targetPath: "/tmp/telepi-handoff.ts",
      },
    });

    runStatusCommand();

    const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("systemd:");
    expect(output).toContain("loaded (active) pid=9999");
    expect(output).toContain("unit present");
    expect(output).toContain("systemd TELEPI_CONFIG");

    // Restore mocks for other tests
    mockState.resolveTelePiInstallContext.mockReturnValue({ version: "1.2.3", platform: "darwin" });
  });

  it("validates unexpected arguments and unknown commands", async () => {
    expect(() => ensureNoArguments("status", ["extra"])).toThrow("Unexpected arguments for status: extra");
    await expect(runSetupCommand(["token"]))
      .rejects.toThrow("Usage: telepi setup [<bot_token> <userids> <workspace>]");
    await expect(main(["wat"]))
      .rejects.toThrow("Unknown command: wat");
  });
});