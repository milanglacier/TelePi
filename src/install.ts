import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

import { ensureTelePiConfig, getServiceConfigSource } from "./install/config.js";
import { getExtensionStatus, installExtension } from "./install/extension.js";
import {
  buildLaunchAgentPlist,
  getInstalledConfigStatus,
} from "./install/launchd.js";
import { resolveTelePiInstallContext, getServiceManager } from "./install/platform.js";
import {
  type ExtensionInstallMode,
  type ExtensionStatus,
  type ServiceStatus,
  type TelePiConfigSetupResult,
  type TelePiConfigSetupValues,
  type TelePiInstallContext,
  type TelePiSetupOptions,
  type TelePiSetupResult,
  type TelePiStatus,
  type TelePiStatusConfigSource,
} from "./install/shared.js";

// Re-exports for public facade
export { TELEPI_LAUNCHD_LABEL } from "./install/shared.js";
export type {
  ExtensionInstallMode,
  ExtensionStatus,
  LaunchAgentStatus,
  ServiceStatus,
  TelePiConfigSetupResult,
  TelePiConfigSetupValues,
  TelePiInstallContext,
  TelePiSetupOptions,
  TelePiSetupResult,
  TelePiStatus,
  TelePiStatusConfigSource,
} from "./install/shared.js";
export { ensureTelePiConfig } from "./install/config.js";
export { buildLaunchAgentPlist } from "./install/launchd.js";
export { resolveTelePiInstallContext, detectPlatform } from "./install/platform.js";

// ---- getTelePiStatus ----

export function getTelePiStatus(cliModuleUrl: string): TelePiStatus {
  const context = resolveTelePiInstallContext(cliModuleUrl);

  // Config source resolution
  let configInfo: { resolvedPath: string; source: TelePiStatusConfigSource };
  if (context.platform === "darwin") {
    configInfo = getInstalledConfigStatus(context);
  } else {
    configInfo = getServiceConfigSource(context);
  }

  // Service status via platform-agnostic ServiceManager
  const serviceMgr = getServiceManager(context.platform);
  const serviceStatus: ServiceStatus = serviceMgr.getStatus(context);

  return {
    version: context.version,
    resolvedConfigPath: configInfo.resolvedPath,
    configExists: existsSync(configInfo.resolvedPath),
    configSource: configInfo.source,
    service: serviceStatus,
    launchAgent: serviceStatus,
    extension: getExtensionStatus(context),
  };
}

// ---- setupTelePi ----

export async function setupTelePi(
  cliModuleUrl: string,
  options: TelePiSetupOptions = {},
): Promise<TelePiSetupResult> {
  const context = resolveTelePiInstallContext(cliModuleUrl);
  ensureInstallInputsExist(context);

  // Create all necessary directories
  mkdirSync(path.dirname(context.configPath), { recursive: true });

  if (context.platform === "darwin" && context.launchAgentPath) {
    mkdirSync(path.dirname(context.launchAgentPath), { recursive: true });
    if (context.launchAgentLogsDirectory) {
      mkdirSync(context.launchAgentLogsDirectory, { recursive: true });
    }
  }

  if (context.platform === "linux") {
    if (context.serviceUnitPath) {
      mkdirSync(path.dirname(context.serviceUnitPath), { recursive: true });
    }
    if (context.serviceUnitLogsDirectory) {
      mkdirSync(context.serviceUnitLogsDirectory, { recursive: true });
    }
  }

  mkdirSync(path.dirname(context.extensionDestinationPath), { recursive: true });

  // Setup steps
  const configResult = await ensureTelePiConfig(context, options);

  const serviceMgr = getServiceManager(context.platform);
  const unitUpdated = serviceMgr.writeUnitFile(context);
  const { actions: serviceActions, warning: serviceWarning } = serviceMgr.reconcile(context);
  const extensionInstalledAs = installExtension(context);

  return {
    context,
    configCreated: configResult.created,
    configUpdated: configResult.updated,
    unitUpdated,
    launchAgentUpdated: unitUpdated,
    extensionInstalledAs,
    serviceActions,
    launchdActions: serviceActions,
    serviceWarning,
    launchdWarning: serviceWarning,
  };
}

// ---- internal helpers ----

function ensureInstallInputsExist(context: TelePiInstallContext): void {
  if (path.extname(context.cliEntrypointPath) === ".ts") {
    throw new Error(
      `telepi setup requires a built CLI entrypoint at ${path.join(context.packageRoot, "dist", "cli.js")}. Run \`npm run build\` and rerun \`telepi setup\`.`,
    );
  }

  const requiredPaths = [
    context.envExamplePath,
    context.extensionSourcePath,
    context.cliEntrypointPath,
  ];

  if (context.platform === "darwin" && context.launchdTemplatePath) {
    requiredPaths.push(context.launchdTemplatePath);
  }

  if (context.platform === "linux" && context.systemdTemplatePath) {
    requiredPaths.push(context.systemdTemplatePath);
  }

  for (const filePath of requiredPaths) {
    if (!existsSync(filePath)) {
      throw new Error(`Required install asset is missing: ${filePath}`);
    }
  }
}