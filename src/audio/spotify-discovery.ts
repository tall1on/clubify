import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

interface NativeDiscovery {
  findProcessTree?: (imageName: string) => number[];
}

export async function findSpotifyPids(imageName = "Spotify.exe"): Promise<number[]> {
  const safeImageName = imageName.replace(/["\r\n]/g, "");
  const native = nativeFindProcessTree();
  if (native) {
    try {
      const pids = sanitizePids(native(safeImageName));
      if (pids.length > 0) return pids;
    } catch {
      // Fall through to tasklist; native discovery is a fast path, not a requirement.
    }
  }
  try {
    const { stdout } = await execFileAsync(
      "tasklist.exe",
      ["/FI", `IMAGENAME eq ${safeImageName}`, "/FO", "CSV", "/NH"],
      { windowsHide: true, timeout: 4000, maxBuffer: 1024 * 1024 },
    );
    return parseTasklist(stdout, safeImageName);
  } catch (error) {
    return await findWithPowerShell(safeImageName).catch(() => {
      throw error instanceof Error ? error : new Error(String(error));
    });
  }
}

function nativeFindProcessTree(): NativeDiscovery["findProcessTree"] | undefined {
  try {
    return (require("loopback-capture") as NativeDiscovery).findProcessTree;
  } catch {
    return undefined;
  }
}

function sanitizePids(values: number[]): number[] {
  const pids: number[] = [];
  for (const value of values) {
    if (!Number.isInteger(value) || value <= 0) continue;
    if (!pids.includes(value)) pids.push(value);
  }
  return pids;
}

export function parseTasklist(stdout: string, imageName: string): number[] {
  const expected = imageName.toLowerCase();
  const pids: number[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^"([^"]+)","(\d+)"/.exec(line);
    if (!match) continue;
    if (match[1]!.toLowerCase() !== expected) continue;
    const pid = Number(match[2]);
    if (Number.isInteger(pid) && pid > 0) pids.push(pid);
  }
  return [...new Set(pids)].sort((left, right) => left - right);
}

async function findWithPowerShell(imageName: string): Promise<number[]> {
  const processName = imageName.replace(/\.exe$/i, "");
  const script = `Get-Process -Name '${processName.replace(/'/g, "''")}' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id`;
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 },
  );
  return stdout
    .split(/\s+/)
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0)
    .sort((left, right) => left - right);
}
