import { existsSync, readFileSync, accessSync, constants } from "node:fs";
import { join, delimiter } from "node:path";
import { spawnSync } from "node:child_process";

export type RuntimeCapability = { available: boolean; reason: string };
export type RuntimeCapabilities = { local: RuntimeCapability; docker: RuntimeCapability };

export function executableOnPath(name: string): boolean {
  return (process.env.PATH || "").split(delimiter).some(dir => {
    try { accessSync(join(dir, name), constants.X_OK); return true; } catch { return false; }
  });
}

// This is a deployment contract, not a sandbox/security boundary.
export function workspaceCapability(): RuntimeCapability {
  const unavailable = (reason: string) => ({ available: false, reason });
  if (!existsSync("/.dockerenv") && !existsSync("/run/.containerenv")) {
    return unavailable("Workspace execution requires the Heimdall tools container. On the host, use Docker executors.");
  }
  try {
    const manifest = JSON.parse(readFileSync("/etc/heimdall-runtime.json", "utf8"));
    if (manifest.profile !== "full" || !Array.isArray(manifest.commands) || !manifest.commands.length) {
      return unavailable("This container has no verified full tools environment. Rebuild the official image.");
    }
    const missing = manifest.commands.filter((name: string) => !executableOnPath(name));
    if (missing.length) return unavailable(`Missing tools: ${missing.join(", ")}. Rebuild the official image.`);
    return { available: true, reason: "Verified Heimdall tools container; each task uses a separate workspace and process group." };
  } catch {
    return unavailable("This container has no verified full tools environment. Use the official Heimdall image.");
  }
}

let dockerCache: { at: number; key: string; result: RuntimeCapability } | undefined;
export function dockerCapability(): RuntimeCapability {
  const key = [process.env.DOCKER_HOST, process.env.DOCKER_CONTEXT, process.env.PATH].join("|");
  if (dockerCache?.key === key && Date.now() - dockerCache.at < 5000) return dockerCache.result;
  const check = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
    encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "pipe"],
  });
  const result = check.status === 0
    ? { available: true, reason: "Docker engine connected." }
    : { available: false, reason: "Docker engine unavailable. Start Docker on the host or enable the DinD deployment." };
  dockerCache = { at: Date.now(), key, result };
  return result;
}

export function runtimeCapabilities(): RuntimeCapabilities {
  return { local: workspaceCapability(), docker: dockerCapability() };
}
