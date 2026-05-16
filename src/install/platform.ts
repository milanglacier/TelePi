import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

import { getDefaultTelePiConfigPath, getHomeDirectory } from "../paths.js";
import { createLaunchdManager } from "./launchd.js";
import type { ServiceManager } from "./service-manager.js";
import {
  TELEPI_EXTENSION_FILENAME,
  TELEPI_LAUNCH_AGENT_FILENAME,
  TELEPI_LAUNCHD_LABEL,
  TELEPI_SERVICE_UNIT_FILENAME,
  TELEPI_SYSTEMD_LOG_DIR_RELATIVE,
  TELEPI_SYSTEMD_USER_DIR_RELATIVE,
  type PlatformIdentifier,
  type TelePiInstallContext,
} from "./shared.js";
import { createSystemdManager } from "./systemd.js";

/** Auto-detect the runtime platform. Throws on unsupported platforms. */
export function detectPlatform(): PlatformIdentifier {
  if (process.platform === "darwin") return "darwin";
  if (process.platform === "linux") return "linux";

  throw new Error(
    `telepi setup is only supported on macOS and Linux. Current platform: ${process.platform}`,
  );
}

/** Resolve the full install context for the current platform. */
export function resolveTelePiInstallContext(cliModuleUrl: string): TelePiInstallContext {
  const rawCliEntrypointPath = fileURLToPath(cliModuleUrl);
  const packageRoot = path.resolve(path.dirname(rawCliEntrypointPath), "..");
  const cliEntrypointPath = resolveInstalledCliEntrypointPath(packageRoot, rawCliEntrypointPath);
  const homeDirectory = getHomeDirectory();
  const platform = detectPlatform();

  const common = {
    platform,
    packageRoot,
    cliEntrypointPath,
    envExamplePath: path.join(packageRoot, ".env.example"),
    extensionSourcePath: path.join(packageRoot, "extensions", TELEPI_EXTENSION_FILENAME),
    configPath: getDefaultTelePiConfigPath(homeDirectory),
    extensionDestinationPath: path.join(homeDirectory, ".pi", "agent", "extensions", TELEPI_EXTENSION_FILENAME),
    nodeExecutablePath: process.execPath,
    workingDirectory: homeDirectory,
    pathEnvironment: sanitizePath(process.env.PATH),
    version: readPackageVersion(packageRoot),
  };

  if (platform === "darwin") {
    const launchAgentDomain = resolveLaunchAgentDomain();
    return {
      ...common,
      launchdTemplatePath: path.join(packageRoot, "launchd", TELEPI_LAUNCH_AGENT_FILENAME),
      launchAgentPath: path.join(homeDirectory, "Library", "LaunchAgents", TELEPI_LAUNCH_AGENT_FILENAME),
      launchAgentLabel: TELEPI_LAUNCHD_LABEL,
      launchAgentDomain,
      launchAgentServiceTarget: launchAgentDomain ? `${launchAgentDomain}/${TELEPI_LAUNCHD_LABEL}` : undefined,
      launchAgentLogsDirectory: path.join(homeDirectory, "Library", "Logs", "TelePi"),
      launchAgentStdoutPath: path.join(homeDirectory, "Library", "Logs", "TelePi", "telepi.out.log"),
      launchAgentStderrPath: path.join(homeDirectory, "Library", "Logs", "TelePi", "telepi.err.log"),
    };
  }

  // platform === "linux"
  return {
    ...common,
    systemdTemplatePath: path.join(packageRoot, "systemd", TELEPI_SERVICE_UNIT_FILENAME),
    serviceUnitPath: path.join(homeDirectory, TELEPI_SYSTEMD_USER_DIR_RELATIVE, TELEPI_SERVICE_UNIT_FILENAME),
    serviceUnitName: "telepi",
    serviceUnitLogsDirectory: path.join(homeDirectory, TELEPI_SYSTEMD_LOG_DIR_RELATIVE),
    serviceUnitStdoutPath: path.join(homeDirectory, TELEPI_SYSTEMD_LOG_DIR_RELATIVE, "telepi.out.log"),
    serviceUnitStderrPath: path.join(homeDirectory, TELEPI_SYSTEMD_LOG_DIR_RELATIVE, "telepi.err.log"),
  };
}

/**
 * Synchronous factory returning the correct ServiceManager for the given platform.
 */
export function getServiceManager(platform: PlatformIdentifier): ServiceManager {
  if (platform === "darwin") return createLaunchdManager();
  if (platform === "linux") return createSystemdManager();
  throw new Error(`Unsupported platform: ${platform}`);
}

/**
 * Return a platform-appropriate shell command to install a system dependency.
 *
 * macOS → `brew install <name>`
 * Linux  → `sudo apt install <name>` / `sudo dnf install <name>` /
 *          `sudo pacman -S <name>` / generic fallback
 */
export function getPlatformInstallHint(packageName: string): string {
  if (process.platform === "darwin") {
    return `brew install ${packageName}`;
  }

  if (process.platform === "linux") {
    if (commandExists("apt")) return `sudo apt install ${packageName}`;
    if (commandExists("dnf")) return `sudo dnf install ${packageName}`;
    if (commandExists("pacman")) return `sudo pacman -S ${packageName}`;
    return `Install ${packageName} using your package manager`;
  }

  return `Install ${packageName} using your package manager`;
}

function commandExists(command: string): boolean {
  const result = spawnSync("which", [command], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 2000,
  });
  return result.status === 0;
}

/** Sanitize PATH: filter out entries that are clearly not paths (contain spaces or quotes). */
function sanitizePath(rawPath: string | undefined): string | undefined {
  if (!rawPath) return undefined;

  const entries = rawPath.split(":");
  const clean = entries.filter((entry) => {
    const trimmed = entry.trim();
    // Reject entries that are clearly not paths:
    // empty, contain spaces, contain double-quotes, or just a dot
    if (!trimmed) return false;
    if (trimmed === ".") return false;
    if (trimmed.includes('"')) return false;
    if (trimmed.includes(" ")) return false;
    if (trimmed.includes(":")) return false; // "bin":Unknown
    if (trimmed.startsWith("npm")) return false; // npm error output
    if (trimmed.startsWith("To see")) return false;
    return true;
  }).join(":");

  return clean || undefined;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function resolveInstalledCliEntrypointPath(packageRoot: string, raw: string): string {
  if (path.extname(raw) !== ".ts") return raw;
  const built = path.join(packageRoot, "dist", "cli.js");
  return existsSync(built) ? built : raw;
}

function resolveLaunchAgentDomain(): string | undefined {
  const uid = process.getuid?.();
  if (typeof uid === "number") return `gui/${uid}`;
  const rawUid = process.env.UID?.trim();
  if (!rawUid) return undefined;
  const parsed = Number(rawUid);
  return Number.isInteger(parsed) ? `gui/${parsed}` : undefined;
}

function readPackageVersion(packageRoot: string): string {
  const packageJsonPath = path.join(packageRoot, "package.json");
  const raw = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: string };
  return raw.version ?? "0.0.0";
}