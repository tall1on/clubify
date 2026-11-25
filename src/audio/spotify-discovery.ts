import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function findSpotifyPids(imageName = "Spotify.exe"): Promise<number[]> {
  const safeImageName = imageName.replace(/["\r\n]/g, "");
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
