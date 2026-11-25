import type { DspParams, Preset } from "./types.js";

const base: DspParams = {
  effectsEnabled: true,
  inputGainDb: 0,
  bassDb: 6,
  bassFrequency: 90,
  saturation: 0.35,
  compression: 0.45,
  thresholdDb: -20,
  ratio: 3.5,
  reverbMix: 0.25,
  reverbSize: 0.6,
  reverbDamping: 0.45,
  outputGainDb: 0,
};

export const PRESETS: Preset[] = [
  {
    id: "nightclub",
    name: "Nightclub",
    tagline: "Warm sub, tight punch, velvet room",
    accent: "#f43f8f",
    params: { ...base },
  },
  {
    id: "deep-house",
    name: "Deep House",
    tagline: "Round low end and a long smoke-filled tail",
    accent: "#38bdf8",
    params: {
      ...base,
      bassDb: 8,
      bassFrequency: 72,
      saturation: 0.22,
      compression: 0.38,
      thresholdDb: -22,
      ratio: 3,
      reverbMix: 0.36,
      reverbSize: 0.78,
      reverbDamping: 0.5,
      outputGainDb: -1,
    },
  },
  {
    id: "festival",
    name: "Festival",
    tagline: "Loud, forward and unapologetically glued",
    accent: "#fbbf24",
    params: {
      ...base,
      bassDb: 5,
      bassFrequency: 110,
      saturation: 0.58,
      compression: 0.68,
      thresholdDb: -26,
      ratio: 5,
      reverbMix: 0.18,
      reverbSize: 0.42,
      reverbDamping: 0.35,
      outputGainDb: 2,
    },
  },
  {
    id: "warehouse",
    name: "Warehouse",
    tagline: "Dirty drive, concrete reflections, no mercy",
    accent: "#a3e635",
    params: {
      ...base,
      bassDb: 7,
      bassFrequency: 84,
      saturation: 0.78,
      compression: 0.55,
      thresholdDb: -24,
      ratio: 4,
      reverbMix: 0.46,
      reverbSize: 0.88,
      reverbDamping: 0.3,
      outputGainDb: -2,
    },
  },
  {
    id: "clean",
    name: "Clean",
    tagline: "Captured signal, zero coloration",
    accent: "#94a3b8",
    params: {
      ...base,
      effectsEnabled: false,
      bassDb: 0,
      saturation: 0,
      compression: 0,
      reverbMix: 0,
      outputGainDb: 0,
    },
  },
];

export const DEFAULT_PRESET_ID = "nightclub";

export function getPreset(id: string): Preset | undefined {
  return PRESETS.find((preset) => preset.id === id);
}

export function defaultEffects(): DspParams {
  return { ...PRESETS[0]!.params };
}

export function clampParams(params: DspParams): DspParams {
  const clamp = (value: number, min: number, max: number, fallback: number) =>
    Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
  return {
    effectsEnabled: Boolean(params.effectsEnabled),
    inputGainDb: clamp(params.inputGainDb, -24, 12, 0),
    bassDb: clamp(params.bassDb, -12, 18, 0),
    bassFrequency: clamp(params.bassFrequency, 40, 180, 90),
    saturation: clamp(params.saturation, 0, 1, 0),
    compression: clamp(params.compression, 0, 1, 0),
    thresholdDb: clamp(params.thresholdDb, -48, 0, -20),
    ratio: clamp(params.ratio, 1, 20, 3),
    reverbMix: clamp(params.reverbMix, 0, 1, 0),
    reverbSize: clamp(params.reverbSize, 0.2, 0.95, 0.6),
    reverbDamping: clamp(params.reverbDamping, 0, 1, 0.45),
    outputGainDb: clamp(params.outputGainDb, -18, 9, 0),
  };
}

