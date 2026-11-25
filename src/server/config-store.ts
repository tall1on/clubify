import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PRESET_ID, clampParams, defaultEffects, getPreset, neutralEffects } from "../shared/presets.js";
import type { AppConfig, DspParams, Preset } from "../shared/types.js";
import { DEFAULT_BUFFER_MS, MAX_BUFFER_MS, MIN_BUFFER_MS } from "../shared/types.js";

export function configDirectory(): string {
  if (process.env.CLUBIFY_CONFIG_DIR) return process.env.CLUBIFY_CONFIG_DIR;
  const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
  return join(appData, "clubify");
}

export function configPath(): string {
  return join(configDirectory(), "config.json");
}

export function customPresetsPath(): string {
  return join(configDirectory(), "presets.json");
}

const CUSTOM_PRESET_FALLBACK_ACCENT = "#f43f8f";

export function loadCustomPresets(): Preset[] {
  const path = customPresetsPath();
  if (!existsSync(path)) return [];
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(raw)) return [];
    const presets: Preset[] = [];
    for (const entry of raw) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      const id = typeof record.id === "string" ? record.id : "";
      const name = typeof record.name === "string" ? record.name.trim() : "";
      if (!id.startsWith("custom-") || name.length === 0) continue;
      const patch =
        record.params && typeof record.params === "object"
          ? (record.params as Partial<DspParams>)
          : {};
      presets.push({
        id,
        name: name.slice(0, 60),
        tagline:
          typeof record.tagline === "string" && record.tagline.length > 0
            ? record.tagline
            : "Manual preset",
        accent:
          typeof record.accent === "string" && /^#[0-9a-f]{6}$/i.test(record.accent)
            ? record.accent
            : CUSTOM_PRESET_FALLBACK_ACCENT,
        params: clampParams({ ...neutralEffects(), ...patch }),
        custom: true,
      });
    }
    return presets;
  } catch {
    return [];
  }
}

export function saveCustomPresets(presets: Preset[]): void {
  const directory = configDirectory();
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
  writeFileSync(customPresetsPath(), JSON.stringify(presets, null, 2), "utf8");
}

export function loadConfig(): AppConfig {
  const fallback = defaultConfig();
  const path = configPath();
  if (!existsSync(path)) return fallback;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<AppConfig>;
    const customPresets = loadCustomPresets();
    const preset = raw.presetId
      ? getPreset(raw.presetId) ?? customPresets.find((candidate) => candidate.id === raw.presetId)
      : undefined;
    const baseEffects =
      raw.presetId && !preset
        ? neutralEffects()
        : (preset?.params ?? fallback.effects);
    const effects = clampParams({
      ...baseEffects,
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

