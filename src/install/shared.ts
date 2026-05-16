export const TELEPI_LAUNCHD_LABEL = "com.telepi";
export const TELEPI_LAUNCH_AGENT_FILENAME = `${TELEPI_LAUNCHD_LABEL}.plist`;
export const TELEPI_SERVICE_NAME = "telepi";
export const TELEPI_SERVICE_UNIT_FILENAME = `${TELEPI_SERVICE_NAME}.service`;
export const TELEPI_EXTENSION_FILENAME = "telepi-handoff.ts";
export const TELEPI_SETUP_PLACEHOLDER_BOT_TOKEN = "your-bot-token-here";
export const TELEPI_SETUP_PLACEHOLDER_ALLOWED_USER_IDS = "123456789";
export const TELEPI_SETUP_PLACEHOLDER_WORKSPACE = "/absolute/path/to/your/main/project";
export const TELEPI_SYSTEMD_LOG_DIR_RELATIVE = ".local/state/telepi/logs";
export const TELEPI_SYSTEMD_USER_DIR_RELATIVE = ".config/systemd/user";

export type PlatformIdentifier = "darwin" | "linux";

export type LaunchctlResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

export interface TelePiInstallContext {
  platform: PlatformIdentifier;
  packageRoot: string;
  cliEntrypointPath: string;
  envExamplePath: string;
  extensionSourcePath: string;
  configPath: string;
  extensionDestinationPath: string;
  nodeExecutablePath: string;
  workingDirectory: string;
  pathEnvironment: string | undefined;
  version: string;
  // macOS launchd-specific fields
  launchdTemplatePath?: string;
  launchAgentPath?: string;
  launchAgentLabel?: string;
  launchAgentDomain?: string;
  launchAgentServiceTarget?: string;
  launchAgentLogsDirectory?: string;
  launchAgentStdoutPath?: string;
  launchAgentStderrPath?: string;
  // Linux systemd-specific fields
  systemdTemplatePath?: string;
  serviceUnitPath?: string;
  serviceUnitName?: string;
  serviceUnitLogsDirectory?: string;
  serviceUnitStdoutPath?: string;
  serviceUnitStderrPath?: string;
}

/**
 * @deprecated Use ServiceStatus instead. Kept for backward compatibility.
 */
export type LaunchAgentStatus = ServiceStatus;

export interface ServiceStatus {
  unitExists: boolean;
  /** @deprecated Use unitExists instead. Kept for backward compatibility. */
  plistExists: boolean;
  loaded: boolean;
  state: string | undefined;
  pid: number | undefined;
  detail: string;
  error: string | undefined;
}

export type ExtensionInstallMode = "missing" | "symlink" | "copy" | "custom";

export interface ExtensionStatus {
  exists: boolean;
  mode: ExtensionInstallMode;
  detail: string;
  targetPath: string | undefined;
}

export type TelePiStatusConfigSource =
  | "service-env"
  | "service-cwd"
  | "launchd-env"
  | "launchd-cwd"
  | "installed-default";

export interface TelePiStatus {
  version: string;
  resolvedConfigPath: string;
  configExists: boolean;
  configSource: TelePiStatusConfigSource;
  service: ServiceStatus;
  /** @deprecated Use service instead. Kept for backward compatibility. */
  launchAgent: ServiceStatus;
  extension: ExtensionStatus;
}

export interface TelePiSetupOptions {
  telegramBotToken?: string;
  telegramAllowedUserIds?: string;
  workspace?: string;
  stdin?: NodeJS.ReadableStream & {
    isTTY?: boolean;
  };
  stdout?: NodeJS.WritableStream & {
    isTTY?: boolean;
  };
  prompt?: (question: string) => Promise<string>;
}

export interface TelePiConfigSetupValues {
  telegramBotToken: string;
  telegramAllowedUserIds: string;
  workspace: string;
}

export interface TelePiConfigSetupResult {
  created: boolean;
  updated: boolean;
  values: TelePiConfigSetupValues;
}

export interface TelePiSetupResult {
  context: TelePiInstallContext;
  configCreated: boolean;
  configUpdated: boolean;
  unitUpdated: boolean;
  /** @deprecated Use unitUpdated instead. Kept for backward compatibility. */
  launchAgentUpdated: boolean;
  extensionInstalledAs: "symlink" | "copy";
  serviceActions: string[];
  /** @deprecated Use serviceActions instead. Kept for backward compatibility. */
  launchdActions: string[];
  serviceWarning: string | undefined;
  /** @deprecated Use serviceWarning instead. Kept for backward compatibility. */
  launchdWarning: string | undefined;
}