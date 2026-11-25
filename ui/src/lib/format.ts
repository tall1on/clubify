import type { EngineStatus } from "../../../src/shared/types";

export function phaseLabel(phase: EngineStatus["phase"]): string {
  switch (phase) {
    case "running":
      return "Live";
    case "buffering":
      return "Buffering";
    case "waiting-for-spotify":
      return "Waiting for Spotify";
    case "error":
      return "Error";
    default:
      return "Idle";
  }
}

export function formatPids(pids: number[]): string {
  return pids.length === 0 ? "not found" : pids.join(", ");
}

export function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
