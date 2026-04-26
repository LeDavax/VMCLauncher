import path from "node:path";
import type { ServerKind } from "../../shared/contracts";

export type AddonMode = "plugins" | "mods" | "unsupported";

export function getRuntimeDirectoryName(kind: ServerKind): string {
  return kind === "papermc" || kind === "purpur" ? "paper" : "server";
}

export function getRuntimeDirectory(rootDir: string, kind: ServerKind): string {
  return path.join(rootDir, getRuntimeDirectoryName(kind));
}

export function getAddonMode(kind: ServerKind): AddonMode {
  if (kind === "papermc" || kind === "purpur") return "plugins";
  if (kind === "fabric" || kind === "forge" || kind === "neoforge") return "mods";
  return "unsupported";
}

export function getAddonsDirectory(rootDir: string, kind: ServerKind): string | null {
  const runtimeDir = getRuntimeDirectory(rootDir, kind);
  const mode = getAddonMode(kind);
  if (mode === "plugins") return path.join(runtimeDir, "plugins");
  if (mode === "mods") return path.join(runtimeDir, "mods");
  return null;
}
