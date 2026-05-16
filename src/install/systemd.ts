import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { ServiceManager } from "./service-manager.js";
import type { ServiceStatus, TelePiInstallContext } from "./shared.js";

export function createSystemdManager(): ServiceManager {
  return {
    buildUnitFile,
    writeUnitFile,
    reconcile,
    getStatus,
  };
}

/** Render the systemd unit file from the template. Exported for testing. */
export function buildSystemdUnit(context: TelePiInstallContext): string {
  return buildUnitFile(context);
}

/** Write the systemd unit file to disk. Exported for testing. */
export function writeSystemdUnit(context: TelePiInstallContext): boolean {
  return writeUnitFile(context);
}

function buildUnitFile(context: TelePiInstallContext): string {
  if (!context.systemdTemplatePath || !existsSync(context.systemdTemplatePath)) {
    throw new Error("systemd unit template not found");
  }

  let template = readFileSync(context.systemdTemplatePath, "utf8");

  const stdoutPath = context.serviceUnitStdoutPath
    ?? path.join(context.serviceUnitLogsDirectory ?? "", "telepi.out.log");
  const stderrPath = context.serviceUnitStderrPath
    ?? path.join(context.serviceUnitLogsDirectory ?? "", "telepi.err.log");

  template = template.replace(/__TELEPI_WORKDIR__/g, formatSystemdValue(context.workingDirectory));
  template = template.replace(/__TELEPI_NODE_PATH__/g, formatSystemdValue(context.nodeExecutablePath));
  template = template.replace(/__TELEPI_CLI_PATH__/g, formatSystemdValue(context.cliEntrypointPath));
  template = template.replace(/__TELEPI_CONFIG_ENV__/g, formatSystemdEnvironment("TELEPI_CONFIG", context.configPath));
  template = template.replace(/__TELEPI_PATH_ENV__/g, formatSystemdEnvironment("PATH", context.pathEnvironment ?? ""));
  template = template.replace(/__TELEPI_STDOUT_PATH__/g, formatSystemdValue(stdoutPath));
  template = template.replace(/__TELEPI_STDERR_PATH__/g, formatSystemdValue(stderrPath));

  return template;
}

function writeUnitFile(context: TelePiInstallContext): boolean {
  if (!context.serviceUnitPath) {
    return false;
  }

  const nextContents = buildUnitFile(context);
  const previousContents = existsSync(context.serviceUnitPath)
    ? readFileSync(context.serviceUnitPath, "utf8")
    : undefined;

  if (previousContents === nextContents) {
    return false;
  }

  const dir = path.dirname(context.serviceUnitPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(context.serviceUnitPath, nextContents, "utf8");
  return true;
}

function reconcile(context: TelePiInstallContext): { actions: string[]; warning: string | undefined } {
  const actions: string[] = [];

  // Check if systemctl --user is available
  const check = spawnSync("systemctl", ["--user"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (check.error || check.status !== 0) {
    return {
      actions,
      warning:
        "systemctl --user is not available. " +
        "Ensure you have a user systemd session (loginctl enable-linger or run under a desktop session).",
    };
  }

  // daemon-reload
  runSystemctl(actions, ["--user", "daemon-reload"]);

  // enable
  runSystemctl(actions, ["--user", "enable", "telepi.service"]);

  // restart (or start if not yet running)
  const restart = spawnSync("systemctl", ["--user", "restart", "telepi.service"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (restart.status === 0) {
    actions.push("restart telepi.service");
  } else {
    // Try start as fallback
    const start = spawnSync("systemctl", ["--user", "start", "telepi.service"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (start.status === 0) {
      actions.push("start telepi.service");
    } else {
      const detail = (restart.stderr || start.stderr || "").trim();
      return {
        actions,
        warning: detail
          ? `systemctl restart/start telepi.service failed: ${detail}`
          : "systemctl restart/start telepi.service failed.",
      };
    }
  }

  return { actions, warning: undefined };
}

function getStatus(context: TelePiInstallContext): ServiceStatus {
  const unitExists = context.serviceUnitPath ? existsSync(context.serviceUnitPath) : false;

  if (!unitExists) {
    return {
      unitExists: false,
      plistExists: false,
      loaded: false,
      state: "not installed",
      pid: undefined,
      detail: "not installed",
      error: undefined,
    };
  }

  const result = spawnSync(
    "systemctl",
    ["--user", "show", "telepi.service", "--property=ActiveState,MainPID"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );

  if (result.error) {
    return {
      unitExists,
      plistExists: false,
      loaded: false,
      state: undefined,
      pid: undefined,
      detail: "systemctl unavailable",
      error: result.error.message,
    };
  }

  if (result.status !== 0) {
    return {
      unitExists,
      plistExists: false,
      loaded: false,
      state: undefined,
      pid: undefined,
      detail: "installed but not loaded",
      error: (result.stderr || result.stdout || "").trim() || undefined,
    };
  }

  const output = result.stdout;
  const stateMatch = output.match(/^ActiveState=(.+)$/m);
  const pidMatch = output.match(/^MainPID=(\d+)$/m);

  const state = stateMatch?.[1]?.trim();
  const pidRaw = pidMatch?.[1]?.trim();
  const pid = pidRaw ? Number(pidRaw) : undefined;

  return {
    unitExists,
    plistExists: false,
    loaded: state === "active",
    state,
    pid: pid && pid > 0 ? pid : undefined,
    detail: state === "active" ? "loaded" : state ?? "unknown",
    error: undefined,
  };
}

// --- internal helpers ---

function runSystemctl(actions: string[], args: string[]): void {
  const result = spawnSync("systemctl", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status === 0) {
    const label = args.slice(1).join(" ");
    actions.push(label);
  }
}

function formatSystemdEnvironment(name: string, value: string): string {
  return formatSystemdValue(`${name}=${value}`);
}

function formatSystemdValue(value: string): string {
  if (!/[\s"\\]/.test(value)) {
    return value;
  }

  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}