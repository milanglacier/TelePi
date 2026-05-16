import { spawnSync } from "node:child_process";

/**
 * Copy text to the system clipboard using the best available platform utility.
 * Returns true on success.
 *
 * - **macOS**: Uses `pbcopy` (built-in)
 * - **Linux**: Tries `wl-copy` (Wayland), then `xclip -selection clipboard` (X11),
 *   then `xsel --clipboard` (X11 fallback).  Returns false if none are available.
 * - **Other platforms**: Returns `false` silently.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (process.platform === "darwin") {
    return copyViaCommand("pbcopy", [], text);
  }

  if (process.platform === "linux") {
    // Wayland first (modern), then X11
    if (copyViaCommand("wl-copy", [], text)) return true;
    if (copyViaCommand("xclip", ["-selection", "clipboard"], text)) return true;
    if (copyViaCommand("xsel", ["--clipboard"], text)) return true;
    return false;
  }

  return false;
}

/** Spawn a command, pipe text to stdin, return true on zero exit code. */
function copyViaCommand(command: string, args: string[], text: string): boolean {
  try {
    const result = spawnSync(command, args, {
      input: text,
      timeout: 2000,
      encoding: "utf8",
      stdio: ["pipe", "ignore", "ignore"],
    });
    return result.status === 0;
  } catch {
    return false;
  }
}