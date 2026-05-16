import type { ServiceStatus, TelePiInstallContext } from "./shared.js";

/** Result of installing (writing) a service unit file to disk. */
export interface ServiceInstallResult {
  /** Whether the unit file was written (created or updated). */
  unitFileUpdated: boolean;
  /** Ordered list of actions taken (e.g. daemon-reload, enable, start). */
  actions: string[];
  /** Non-fatal warning, if any. */
  warning: string | undefined;
}

/** Result of reconciling (restarting/reloading) a running service. */
export interface ServiceReconcileResult {
  /** Ordered list of actions taken. */
  actions: string[];
  /** Non-fatal warning, if any. */
  warning: string | undefined;
}

/**
 * Platform-agnostic abstraction over service lifecycle operations.
 *
 * Implementations:
 *  - `LaunchdManager` in {@link launchd.ts} (macOS)
 *  - `SystemdManager` in {@link systemd.ts} (Linux)
 */
export interface ServiceManager {
  /** Build the platform-specific service unit file content from context. Does NOT write to disk. */
  buildUnitFile(context: TelePiInstallContext): string;

  /**
   * Write the service unit file to disk if it has changed.
   * Returns true if the file was written (created or updated).
   */
  writeUnitFile(context: TelePiInstallContext): boolean;

  /** Reload/restart the service so that any config changes take effect. */
  reconcile(context: TelePiInstallContext): ServiceReconcileResult;

  /** Query the current status of the installed service. */
  getStatus(context: TelePiInstallContext): ServiceStatus;
}