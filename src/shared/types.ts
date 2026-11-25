export const SAMPLE_RATE = 48_000;
export const CHANNELS = 2;
export const CAPTURE_BYTES_PER_SAMPLE = 2;
export const CAPTURE_FRAME_BYTES = CHANNELS * CAPTURE_BYTES_PER_SAMPLE;
export const OUTPUT_BYTES_PER_SAMPLE = 4;
export const OUTPUT_FRAME_BYTES = CHANNELS * OUTPUT_BYTES_PER_SAMPLE;
export const DSP_BLOCK_FRAMES = 256;
export const OUTPUT_BLOCK_FRAMES = 480;
export const MAX_AUTO_GAIN_DB = 12;

export const MIN_BUFFER_MS = 16;
export const MAX_BUFFER_MS = 240;
export const DEFAULT_BUFFER_MS = 48;

export interface DspParams {
  effectsEnabled: boolean;
  inputGainDb: number;
  bassDb: number;
  bassFrequency: number;
  lowMidCutDb: number;
  lowMidFrequency: number;
  presenceDb: number;
  presenceFrequency: number;
  airDampingHz: number;
  width: number;
  distance: number;
  saturation: number;
  compression: number;
  thresholdDb: number;
  ratio: number;
  earlyReflections: number;
  reverbMix: number;
  reverbSize: number;
  reverbDamping: number;
  reverbPredelayMs: number;
  reverbDuck: number;
  outputGainDb: number;
}

export interface Preset {
  id: string;
  name: string;
  tagline: string;
  accent: string;
  params: DspParams;
}

export interface AppConfig {
  presetId: string;
  effects: DspParams;
  spotifyImageName: string;
  outputDeviceName: string | null;
  targetBufferMs: number;
  autoGain: boolean;
}

export type EnginePhase =
  | "idle"
  | "waiting-for-spotify"
  | "buffering"
  | "running"
  | "error";

export interface AudioLevel {
  peakDb: number;
  rmsDb: number;
}

export interface OutputDevice {
  id: number;
  name: string;
  isDefault: boolean;
  outputChannels: number;
  preferredSampleRate: number;
}

export interface EngineStatus {
  phase: EnginePhase;
  message: string | null;
  spotifyPids: number[];
  capturePid: number | null;
  captureActive: boolean;
  outputActive: boolean;
  outputDeviceName: string | null;
  sampleRate: number;
  bufferMs: number;
  targetBufferMs: number;
  level: AudioLevel;
  underruns: number;
  overruns: number;
  droppedChunks: number;
  lastError: string | null;
  autoGainDb: number;
  virtualCableDetected: boolean;
  uptimeSec: number;
}

export interface PublicState {
  config: AppConfig;
  status: EngineStatus;
  presets: Preset[];
  devices: OutputDevice[];
}

export type ClientMessage =
  | { type: "set-effects"; effects: Partial<DspParams> }
  | { type: "set-preset"; presetId: string }
  | { type: "set-output-device"; deviceName: string | null }
  | { type: "set-buffer"; ms: number }
  | { type: "set-auto-gain"; enabled: boolean }
  | { type: "set-bypass"; bypass: boolean }
  | { type: "restart" }
  | { type: "request-state" };

export type ServerMessage =
  | { type: "state"; state: PublicState }
  | { type: "status"; status: EngineStatus }
  | { type: "error"; message: string };
