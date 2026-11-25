import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PRESET_ID, clampParams, defaultEffects, getPreset } from "../shared/presets.js";
import type { AppConfig, DspParams } from "../shared/types.js";
import { DEFAULT_BUFFER_MS, MAX_BUFFER_MS, MIN_BUFFER_MS } from "../shared/types.js";

export function configDirectory(): string {
  if (process.env.CLUBIFY_CONFIG_DIR) return process.env.CLUBIFY_CONFIG_DIR;
  const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
  return join(appData, "clubify");
}

export function configPath(): string {
  return join(configDirectory(), "config.json");
}

export function loadConfig(): AppConfig {
  const fallback = defaultConfig();
  const path = configPath();
  if (!existsSync(path)) return fallback;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<AppConfig>;
    const preset = raw.presetId ? getPreset(raw.presetId) : undefined;
    const effects = clampParams({
      ...(preset?.params ?? fallback.effects),
      ...(raw.effects ?? {}),
    });
    return {
      presetId: raw.presetId ?? fallback.presetId,
      effects,
      spotifyImageName:
        typeof raw.spotifyImageName === "string" && raw.spotifyImageName.trim().length > 0
          ? raw.spotifyImageName
          : fallback.spotifyImageName,
      outputDeviceName:
        typeof raw.outputDeviceName === "string" && raw.outputDeviceName.length > 0
          ? raw.outputDeviceName
          : null,
      targetBufferMs: clampBuffer(raw.targetBufferMs ?? fallback.targetBufferMs),
      autoGain: typeof raw.autoGain === "boolean" ? raw.autoGain : fallback.autoGain,
    };
  } catch {
    return fallback;
  }
}

export function saveConfig(config: AppConfig): void {
  const directory = configDirectory();
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
  writeFileSync(configPath(), JSON.stringify(config, null, 2), "utf8");
}

export function defaultConfig(): AppConfig {
  return {
    presetId: DEFAULT_PRESET_ID,
    effects: defaultEffects(),
    spotifyImageName: "Spotify.exe",
    outputDeviceName: null,
    targetBufferMs: DEFAULT_BUFFER_MS,
    autoGain: true,
  };
}

export function clampBuffer(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_BUFFER_MS;
  return Math.min(MAX_BUFFER_MS, Math.max(MIN_BUFFER_MS, Math.round(value)));
}

export function mergeEffects(current: DspParams, patch: Partial<DspParams>): DspParams {
  return clampParams({ ...current, ...patch });
}

