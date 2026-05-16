import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildLaunchAgentPlist,
  ensureTelePiConfig,
  getTelePiStatus,
  resolveTelePiInstallContext,
  setupTelePi,
} from "../src/install.js";
import { getServiceConfigSource } from "../src/install/config.js";

describe("install helpers", () => {
  const originalCwd = process.cwd();
  const originalEnv = process.env;
  const originalPlatform = process.platform;
  let tempDir: string;
  let homeDir: string;
  let packageRoot: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "telepi-install-"));
    homeDir = path.join(tempDir, "home");
    packageRoot = path.join(tempDir, "package");

    mkdirSync(homeDir, { recursive: true });
    mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
    mkdirSync(path.join(packageRoot, "launchd"), { recursive: true });
    mkdirSync(path.join(packageRoot, "systemd"), { recursive: true });
    mkdirSync(path.join(packageRoot, "extensions"), { recursive: true });

    writeFileSync(path.join(packageRoot, "package.json"), '{"version":"9.9.9"}\n');
    writeFileSync(
      path.join(packageRoot, ".env.example"),
      [
        "TELEGRAM_BOT_TOKEN=your-bot-token-here",
        "TELEGRAM_ALLOWED_USER_IDS=123456789",
        "# TELEPI_WORKSPACE=/absolute/path/to/your/main/project",
        "# TOOL_VERBOSITY=summary",
        "# OPENAI_API_KEY=sk-...",
      ].join("\n") + "\n",
    );
    writeFileSync(
      path.join(packageRoot, "launchd", "com.telepi.plist"),
      [
        "<plist>",
        "/ABSOLUTE/PATH/TO/WORKDIR",
        "/ABSOLUTE/PATH/TO/node",
        "/ABSOLUTE/PATH/TO/TelePi/dist/cli.js",
        "__TELEPI_PATH_ENV_BLOCK__",
        "/ABSOLUTE/PATH/TO/telepi.out.log",
        "/ABSOLUTE/PATH/TO/telepi.err.log",
        "</plist>",
      ].join("\n"),
    );
    writeFileSync(path.join(packageRoot, "extensions", "telepi-handoff.ts"), "export default {};\n");
    writeFileSync(path.join(packageRoot, "dist", "cli.js"), "#!/usr/bin/env node\n");
    writeFileSync(
      path.join(packageRoot, "systemd", "telepi.service"),
      [
        "[Unit]",
        "Description=TelePi Telegram Bot",
        "After=network.target",
        "",
        "[Service]",
        "Type=simple",
        "WorkingDirectory=__TELEPI_WORKDIR__",
        "ExecStart=__TELEPI_NODE_PATH__ __TELEPI_CLI_PATH__ start",
        "Environment=TELEPI_CONFIG=__TELEPI_CONFIG__",
        "Environment=PATH=__TELEPI_PATH_ENV__",
        "StandardOutput=append:__TELEPI_LOG_DIR__/telepi.out.log",
        "StandardError=append:__TELEPI_LOG_DIR__/telepi.err.log",
        "Restart=on-failure",
        "RestartSec=5",
        "",
        "[Install]",
        "WantedBy=default.target",
      ].join("\n"),
    );

    process.chdir(packageRoot);
    process.env = {
      ...originalEnv,
      HOME: homeDir,
      PATH: "/opt/homebrew/bin:/usr/bin",
      UID: "501",
    };
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
    process.env = originalEnv;
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    vi.restoreAllMocks();
  });

  it("resolves installed-mode paths from the CLI entrypoint on macOS", () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    const cliModuleUrl = pathToFileURL(path.join(packageRoot, "dist", "cli.js")).href;

    const context = resolveTelePiInstallContext(cliModuleUrl);

    expect(context.platform).toBe("darwin");
    expect(context.packageRoot).toBe(packageRoot);
    expect(context.cliEntrypointPath).toBe(path.join(packageRoot, "dist", "cli.js"));
    expect(context.configPath).toBe(path.join(homeDir, ".config", "telepi", "config.env"));
    expect(context.launchAgentPath).toBe(
      path.join(homeDir, "Library", "LaunchAgents", "com.telepi.plist"),
    );
    expect(context.extensionDestinationPath).toBe(
      path.join(homeDir, ".pi", "agent", "extensions", "telepi-handoff.ts"),
    );
    expect(context.version).toBe("9.9.9");
  });

  it("renders a launchd plist that starts the CLI via node", () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    const cliModuleUrl = pathToFileURL(path.join(packageRoot, "dist", "cli.js")).href;
    const context = resolveTelePiInstallContext(cliModuleUrl);

    const plist = buildLaunchAgentPlist(context);

    expect(plist).toContain(context.workingDirectory);
    expect(plist).toContain(context.nodeExecutablePath);
    expect(plist).toContain(context.cliEntrypointPath);
    expect(plist).toContain(context.launchAgentStdoutPath);
    expect(plist).toContain(context.launchAgentStderrPath);
    expect(plist).toContain("<key>EnvironmentVariables</key>");
    expect(plist).toContain("<key>TELEPI_CONFIG</key>");
    expect(plist).toContain(context.configPath);
    expect(plist).toContain("/opt/homebrew/bin:/usr/bin");
    expect(plist).not.toContain("__TELEPI_PATH_ENV_BLOCK__");
  });

  it("writes required setup values from fast setup args into a new config file", async () => {
    const cliModuleUrl = pathToFileURL(path.join(packageRoot, "dist", "cli.js")).href;
    const context = resolveTelePiInstallContext(cliModuleUrl);

    const result = await ensureTelePiConfig(context, {
      telegramBotToken: "12345:ABCDEF",
      telegramAllowedUserIds: "11, 22",
      workspace: "../workspace",
    });
    const contents = readFileSync(context.configPath, "utf8");

    expect(result.created).toBe(true);
    expect(result.updated).toBe(true);
    const expectedWorkspace = path.resolve(process.cwd(), "..", "workspace");

    expect(result.values).toEqual({
      telegramBotToken: "12345:ABCDEF",
      telegramAllowedUserIds: "11, 22",
      workspace: expectedWorkspace,
    });
    expect(contents).toContain("TELEGRAM_BOT_TOKEN=12345:ABCDEF");
    expect(contents).toContain('TELEGRAM_ALLOWED_USER_IDS="11, 22"');
    expect(contents).toContain(`TELEPI_WORKSPACE=${expectedWorkspace}`);
    expect(contents).toContain("# TOOL_VERBOSITY=summary");
    expect(contents).toContain("# OPENAI_API_KEY=sk-...");
    expect(contents).not.toContain("your-bot-token-here");
  });

  it("preserves optional config values when updating required setup values", async () => {
    const cliModuleUrl = pathToFileURL(path.join(packageRoot, "dist", "cli.js")).href;
    const context = resolveTelePiInstallContext(cliModuleUrl);

    mkdirSync(path.dirname(context.configPath), { recursive: true });
    writeFileSync(
      context.configPath,
      [
        "TELEGRAM_BOT_TOKEN=old-token",
        "TELEGRAM_ALLOWED_USER_IDS=111",
        "TELEPI_WORKSPACE=/old/workspace",
        "TOOL_VERBOSITY=errors-only",
        "OPENAI_API_KEY=sk-existing",
      ].join("\n") + "\n",
    );

    const result = await ensureTelePiConfig(context, {
      telegramBotToken: "new-token",
      telegramAllowedUserIds: "222,333",
      workspace: "/new/workspace",
    });
    const contents = readFileSync(context.configPath, "utf8");

    expect(result.created).toBe(false);
    expect(result.updated).toBe(true);
    expect(contents).toContain("TELEGRAM_BOT_TOKEN=new-token");
    expect(contents).toContain("TELEGRAM_ALLOWED_USER_IDS=222,333");
    expect(contents).toContain("TELEPI_WORKSPACE=/new/workspace");
    expect(contents).toContain("TOOL_VERBOSITY=errors-only");
    expect(contents).toContain("OPENAI_API_KEY=sk-existing");
  });

  it("prompts for setup values in interactive mode when no args are provided", async () => {
    const cliModuleUrl = pathToFileURL(path.join(packageRoot, "dist", "cli.js")).href;
    const context = resolveTelePiInstallContext(cliModuleUrl);
    const prompt = vi
      .fn<(_: string) => Promise<string>>()
      .mockResolvedValueOnce("prompt-token")
      .mockResolvedValueOnce("444,555")
      .mockResolvedValueOnce("../interactive-workspace");

    const result = await ensureTelePiConfig(context, {
      stdin: createTtyStub(true) as NodeJS.ReadableStream & { isTTY: boolean },
      stdout: createTtyStub(true) as NodeJS.WritableStream & { isTTY: boolean },
      prompt,
    });
    const contents = readFileSync(context.configPath, "utf8");

    const expectedWorkspace = path.resolve(process.cwd(), "..", "interactive-workspace");

    expect(result.values).toEqual({
      telegramBotToken: "prompt-token",
      telegramAllowedUserIds: "444,555",
      workspace: expectedWorkspace,
    });
    expect(prompt.mock.calls).toEqual([
      ["TELEGRAM_BOT_TOKEN: "],
      ["TELEGRAM_ALLOWED_USER_IDS: "],
      ["TELEPI_WORKSPACE: "],
    ]);
    expect(contents).toContain("TELEGRAM_BOT_TOKEN=prompt-token");
    expect(contents).toContain("TELEGRAM_ALLOWED_USER_IDS=444,555");
    expect(contents).toContain(`TELEPI_WORKSPACE=${expectedWorkspace}`);
  });

  it("does not treat template example setup values as interactive defaults", async () => {
    const cliModuleUrl = pathToFileURL(path.join(packageRoot, "dist", "cli.js")).href;
    const context = resolveTelePiInstallContext(cliModuleUrl);

    const prompt = vi
      .fn<(_: string) => Promise<string>>()
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("");

    await expect(
      ensureTelePiConfig(context, {
        stdin: createTtyStub(true) as NodeJS.ReadableStream & { isTTY: boolean },
        stdout: createTtyStub(true) as NodeJS.WritableStream & { isTTY: boolean },
        prompt,
      }),
    ).rejects.toThrow(
      "Missing required TelePi setup values: TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USER_IDS, TELEPI_WORKSPACE.",
    );
    expect(prompt.mock.calls).toEqual([
      ["TELEGRAM_BOT_TOKEN: "],
      ["TELEGRAM_ALLOWED_USER_IDS: "],
      ["TELEPI_WORKSPACE: "],
    ]);
  });

  it("keeps persisted TELEGRAM_ALLOWED_USER_IDS values even when they match the example", async () => {
    const cliModuleUrl = pathToFileURL(path.join(packageRoot, "dist", "cli.js")).href;
    const context = resolveTelePiInstallContext(cliModuleUrl);

    mkdirSync(path.dirname(context.configPath), { recursive: true });
    writeFileSync(
      context.configPath,
      [
        "TELEGRAM_BOT_TOKEN=existing-token",
        "TELEGRAM_ALLOWED_USER_IDS=123456789",
        "TELEPI_WORKSPACE=/real/workspace",
      ].join("\n") + "\n",
    );

    const prompt = vi
      .fn<(_: string) => Promise<string>>()
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("");

    const result = await ensureTelePiConfig(context, {
      stdin: createTtyStub(true) as NodeJS.ReadableStream & { isTTY: boolean },
      stdout: createTtyStub(true) as NodeJS.WritableStream & { isTTY: boolean },
      prompt,
    });

    expect(result.created).toBe(false);
    expect(result.updated).toBe(false);
    expect(result.values).toEqual({
      telegramBotToken: "existing-token",
      telegramAllowedUserIds: "123456789",
      workspace: "/real/workspace",
    });
    expect(prompt.mock.calls).toEqual([
      ["TELEGRAM_BOT_TOKEN [press enter to keep current]: "],
      ["TELEGRAM_ALLOWED_USER_IDS [123456789]: "],
      ["TELEPI_WORKSPACE [/real/workspace]: "],
    ]);
  });

  it("fails clearly in non-interactive mode when required setup values are missing", async () => {
    const cliModuleUrl = pathToFileURL(path.join(packageRoot, "dist", "cli.js")).href;
    const context = resolveTelePiInstallContext(cliModuleUrl);

    await expect(
      ensureTelePiConfig(context, {
        stdin: createTtyStub(false) as NodeJS.ReadableStream & { isTTY: boolean },
        stdout: createTtyStub(false) as NodeJS.WritableStream & { isTTY: boolean },
      }),
    ).rejects.toThrow(
      "Missing required TelePi setup values: TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USER_IDS, TELEPI_WORKSPACE.",
    );
    expect(() => readFileSync(context.configPath, "utf8")).toThrow();
  });

  it("reports the launchd TELEPI_CONFIG path instead of the caller cwd", () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    const cliModuleUrl = pathToFileURL(path.join(packageRoot, "dist", "cli.js")).href;
    const context = resolveTelePiInstallContext(cliModuleUrl);
    const callerCwd = path.join(tempDir, "caller-cwd");

    mkdirSync(callerCwd, { recursive: true });
    mkdirSync(path.dirname(context.configPath), { recursive: true });
    if (context.launchAgentPath) {
      mkdirSync(path.dirname(context.launchAgentPath), { recursive: true });
    }
    writeFileSync(path.join(callerCwd, ".env"), "TELEGRAM_BOT_TOKEN=from-caller\n");
    writeFileSync(context.configPath, "TELEGRAM_BOT_TOKEN=from-installed\n");
    if (context.launchAgentPath) {
      writeFileSync(context.launchAgentPath, buildLaunchAgentPlist(context));
    }
    process.chdir(callerCwd);

    const status = getTelePiStatus(cliModuleUrl);

    expect(status.resolvedConfigPath).toBe(context.configPath);
    expect(status.configExists).toBe(true);
    expect(status.configSource).toBe("launchd-env");
  });

  it("reports the installed extension as a symlink when it points to the package source", () => {
    const cliModuleUrl = pathToFileURL(path.join(packageRoot, "dist", "cli.js")).href;
    const context = resolveTelePiInstallContext(cliModuleUrl);

    mkdirSync(path.dirname(context.extensionDestinationPath), { recursive: true });
    symlinkSync(context.extensionSourcePath, context.extensionDestinationPath);

    const status = getTelePiStatus(cliModuleUrl);

    expect(status.extension.exists).toBe(true);
    expect(status.extension.mode).toBe("symlink");
    expect(status.extension.targetPath).toBe(context.extensionSourcePath);
  });

  it("reports the installed extension as a copy when the destination matches the source file", () => {
    const cliModuleUrl = pathToFileURL(path.join(packageRoot, "dist", "cli.js")).href;
    const context = resolveTelePiInstallContext(cliModuleUrl);

    mkdirSync(path.dirname(context.extensionDestinationPath), { recursive: true });
    writeFileSync(
      context.extensionDestinationPath,
      readFileSync(context.extensionSourcePath, "utf8"),
      "utf8",
    );

    const status = getTelePiStatus(cliModuleUrl);

    expect(status.extension.exists).toBe(true);
    expect(status.extension.mode).toBe("copy");
    expect(status.extension.targetPath).toBeUndefined();
  });

  it("requires dist/cli.js before telepi setup when invoked from src/cli.ts", async () => {
    const srcCliPath = path.join(packageRoot, "src", "cli.ts");
    mkdirSync(path.dirname(srcCliPath), { recursive: true });
    writeFileSync(srcCliPath, "#!/usr/bin/env node\n");
    rmSync(path.join(packageRoot, "dist", "cli.js"));
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });

    await expect(setupTelePi(pathToFileURL(srcCliPath).href)).rejects.toThrow(
      `telepi setup requires a built CLI entrypoint at ${path.join(packageRoot, "dist", "cli.js")}`,
    );
  });

  // --- Linux-specific tests ---

  it("resolves Linux context with systemd fields and no launchd fields", () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const cliModuleUrl = pathToFileURL(path.join(packageRoot, "dist", "cli.js")).href;

    const context = resolveTelePiInstallContext(cliModuleUrl);

    expect(context.platform).toBe("linux");
    // Linux-specific fields populated
    expect(context.systemdTemplatePath).toContain("telepi.service");
    expect(context.serviceUnitPath).toContain(".config/systemd/user/telepi.service");
    expect(context.serviceUnitName).toBe("telepi");
    expect(context.serviceUnitLogsDirectory).toContain(".local/state/telepi/logs");
    expect(context.serviceUnitStdoutPath).toContain("telepi.out.log");
    expect(context.serviceUnitStderrPath).toContain("telepi.err.log");
    // macOS fields NOT populated on Linux
    expect(context.launchdTemplatePath).toBeUndefined();
    expect(context.launchAgentPath).toBeUndefined();
    expect(context.launchAgentLabel).toBeUndefined();
  });

  it("resolves macOS context with launchd fields and no systemd fields", () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    const cliModuleUrl = pathToFileURL(path.join(packageRoot, "dist", "cli.js")).href;

    const context = resolveTelePiInstallContext(cliModuleUrl);

    expect(context.platform).toBe("darwin");
    expect(context.launchdTemplatePath).toContain("com.telepi.plist");
    expect(context.launchAgentPath).toContain("LaunchAgents/com.telepi.plist");
    expect(context.launchAgentLabel).toBe("com.telepi");
    // Linux fields NOT populated on macOS
    expect(context.systemdTemplatePath).toBeUndefined();
    expect(context.serviceUnitPath).toBeUndefined();
    expect(context.serviceUnitName).toBeUndefined();
  });

  it("throws for unsupported platforms", () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const cliModuleUrl = pathToFileURL(path.join(packageRoot, "dist", "cli.js")).href;

    expect(() => resolveTelePiInstallContext(cliModuleUrl)).toThrow(
      "telepi setup is only supported on macOS and Linux",
    );
  });

  it("getTelePiStatus on Linux returns service field with systemd status", () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const cliModuleUrl = pathToFileURL(path.join(packageRoot, "dist", "cli.js")).href;

    const status = getTelePiStatus(cliModuleUrl);

    expect(status.service).toBeDefined();
    expect(status.service.unitExists).toBe(false); // service not installed yet
    expect(status.service.loaded).toBe(false);
    // field names are platform-neutral
    expect(status.configSource).toBe("installed-default");
    expect(status.extension.mode).toBe("missing");
  });

  it("getServiceConfigSource returns service-env when TELEPI_CONFIG is in systemd unit", () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const cliModuleUrl = pathToFileURL(path.join(packageRoot, "dist", "cli.js")).href;
    const ctx = resolveTelePiInstallContext(cliModuleUrl);

    // Write a systemd unit file with explicit TELEPI_CONFIG
    if (ctx.serviceUnitPath) {
      mkdirSync(path.dirname(ctx.serviceUnitPath), { recursive: true });
      writeFileSync(ctx.serviceUnitPath, [
        "[Service]",
        `Environment=TELEPI_CONFIG=${ctx.configPath}`,
        `WorkingDirectory=${ctx.workingDirectory}`,
      ].join("\n"));
    }

    const info = getServiceConfigSource(ctx);
    expect(info.source).toBe("service-env");
    expect(info.resolvedPath).toBe(ctx.configPath);
  });

  it("getServiceConfigSource returns service-cwd when .env exists in working dir", () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const cliModuleUrl = pathToFileURL(path.join(packageRoot, "dist", "cli.js")).href;
    const ctx = resolveTelePiInstallContext(cliModuleUrl);

    // Write a unit file without TELEPI_CONFIG, but with .env in working dir
    if (ctx.serviceUnitPath) {
      mkdirSync(path.dirname(ctx.serviceUnitPath), { recursive: true });
      writeFileSync(ctx.serviceUnitPath, [
        "[Service]",
        `WorkingDirectory=${ctx.workingDirectory}`,
      ].join("\n"));
    }
    writeFileSync(path.join(ctx.workingDirectory, ".env"), "TELEGRAM_BOT_TOKEN=test\n");

    const info = getServiceConfigSource(ctx);
    expect(info.source).toBe("service-cwd");
    expect(info.resolvedPath).toBe(path.join(ctx.workingDirectory, ".env"));
  });

  it("getServiceConfigSource returns installed-default when no unit or .env exists", () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const cliModuleUrl = pathToFileURL(path.join(packageRoot, "dist", "cli.js")).href;
    const ctx = resolveTelePiInstallContext(cliModuleUrl);
    // Don't create any service unit file
    ctx.serviceUnitPath = path.join(tmpdir(), "nonexistent", "telepi.service");

    const info = getServiceConfigSource(ctx);
    expect(info.source).toBe("installed-default");
    expect(info.resolvedPath).toBe(ctx.configPath);
  });
});

function createTtyStub(isTTY: boolean): { isTTY: boolean } {
  return { isTTY };
}
