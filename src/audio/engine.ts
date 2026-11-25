import { EventEmitter } from "node:events";
import { DspChain } from "../dsp/chain.js";
import {
  DEFAULT_BUFFER_MS,
  DEFAULT_SAMPLE_RATE,
  DSP_BLOCK_FRAMES,
  MAX_AUTO_GAIN_DB,
  MAX_BUFFER_MS,
  MIN_BUFFER_MS,
  OUTPUT_BLOCK_MS,
  OUTPUT_FRAME_BYTES,
  type AppConfig,
  type AudioLevel,
  type CaptureFormat,
  type DspParams,
  type EnginePhase,
  type EngineStatus,
  type OutputDevice,
  type Preset,
  type PublicState,
} from "../shared/types.js";
import { PRESETS, clampParams, getPreset } from "../shared/presets.js";
import { BlockAssembler, interleavedToBuffer, silentPcm } from "./pcm.js";
import { PlaybackQueue } from "./playback-queue.js";
import { SpotifyCapture } from "./spotify-capture.js";
import { findSpotifyPids } from "./spotify-discovery.js";
import { WasapiOutput } from "./wasapi-output.js";
import {
  loadCustomPresets,
  mergeEffects,
  saveConfig,
  saveCustomPresets,
} from "../server/config-store.js";

const DISCOVERY_INTERVAL_MS = 2_000;
const STATUS_INTERVAL_MS = 250;
const TAIL_INTERVAL_MS = 5;
const TAIL_LIFETIME_MS = 6_000;
const SILENCE_AFTER_MS = 120;

export class AudioEngine extends EventEmitter {
  private readonly config: AppConfig;
  private customPresets: Preset[];
  private dsp: DspChain;
  private readonly output = new WasapiOutput();
  private readonly capture = new SpotifyCapture();
  private assembler = new BlockAssembler(DSP_BLOCK_FRAMES);
  private readonly queue = new PlaybackQueue();
  private readonly zeroLeft = new Float32Array(DSP_BLOCK_FRAMES);
  private readonly zeroRight = new Float32Array(DSP_BLOCK_FRAMES);

  private devices: OutputDevice[] = [];
  private outputDeviceName: string | null = null;
  private sampleRate = DEFAULT_SAMPLE_RATE;
  private captureSampleRate = DEFAULT_SAMPLE_RATE;
  private captureFormat: CaptureFormat = "f32";
  private targetFrames: number;
  private outputPrimed = false;
  private outputSilence: Buffer = Buffer.alloc(
    Math.round((DEFAULT_SAMPLE_RATE * OUTPUT_BLOCK_MS) / 1_000) * OUTPUT_FRAME_BYTES,
  );
  private discoveryTimer: NodeJS.Timeout | null = null;
  private statusTimer: NodeJS.Timeout | null = null;
  private tailTimer: NodeJS.Timeout | null = null;
  private saveTimer: NodeJS.Timeout | null = null;
  private readonly startedAt = Date.now();
  private lastCaptureAt = 0;
  private lastChunkCount = 0;
  private spotifyPids: number[] = [];
  private captureError: string | null = null;
  private outputError: string | null = null;
  private warning: string | null = null;
  private tapWarning: string | null = null;
  private silencingMode: "tap" | "cable" | "none" = "none";
  private hasProcessedAudio = false;
  private stopping = false;
  private underruns = 0;
  private overruns = 0;
  private droppedFrames = 0;
  private smoothedPeak = 0;
  private smoothedPower = 0;
  private firstPacketAt = 0;
  private autoGain = 1;
  private driftIntegral = 0;
  private smoothedFillFrames = 0;
  private driftSettled = true;

  constructor(config: AppConfig) {
    super();
    this.config = config;
    this.customPresets = loadCustomPresets();
    this.targetFrames = Math.round((config.targetBufferMs * this.sampleRate) / 1000);
    this.dsp = new DspChain(this.sampleRate, config.effects, DSP_BLOCK_FRAMES);
  }

  get configSnapshot(): AppConfig {
    return this.config;
  }

  async start(): Promise<void> {
    this.stopping = false;
    this.refreshDevices();
    this.setSampleRate(this.output.preferredRate(this.config.outputDeviceName));
    this.openOutput();
    this.discoveryTimer = setInterval(() => {
      void this.pollSpotify();
    }, DISCOVERY_INTERVAL_MS);
    this.statusTimer = setInterval(() => {
      this.tick();
    }, STATUS_INTERVAL_MS);
    this.tailTimer = setInterval(() => {
      this.pumpTail();
    }, TAIL_INTERVAL_MS);
    await this.pollSpotify();
    this.emitStatus();
  }

  stop(): void {
    this.stopping = true;
    if (this.discoveryTimer) clearInterval(this.discoveryTimer);
    if (this.statusTimer) clearInterval(this.statusTimer);
    if (this.tailTimer) clearInterval(this.tailTimer);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.discoveryTimer = null;
    this.statusTimer = null;
    this.tailTimer = null;
    this.saveTimer = null;
    this.capture.stop();
    this.output.stop();
    this.queue.clear();
    this.save();
  }

  getState(refreshDevices = false): PublicState {
    if (refreshDevices) this.refreshDevices();
    return {
      config: this.config,
      status: this.status(),
      presets: [...PRESETS, ...this.customPresets],
      devices: this.devices,
    };
  }

  setPreset(presetId: string): void {
    const preset =
      getPreset(presetId) ?? this.customPresets.find((candidate) => candidate.id === presetId);
    if (!preset) throw new Error(`Unknown preset: ${presetId}`);
    this.config.presetId = preset.id;
    this.config.effects = clampParams({ ...preset.params });
    this.dsp.setParams(this.config.effects);
    this.scheduleSave();
    this.emitStatus();
  }

  savePreset(name: string): void {
    const trimmed = name.trim().slice(0, 60);
    if (!trimmed) throw new Error("Preset name is required");
    const preset: Preset = {
      id: `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      name: trimmed,
      tagline: "Manual preset",
      accent: customPresetAccent(trimmed),
      params: clampParams({ ...this.config.effects }),
      custom: true,
    };
    this.customPresets.push(preset);
    saveCustomPresets(this.customPresets);
    this.config.presetId = preset.id;
    this.config.effects = clampParams({ ...preset.params });
    this.dsp.setParams(this.config.effects);
    this.scheduleSave();
    this.emitStatus();
  }

  deletePreset(presetId: string): void {
    const index = this.customPresets.findIndex((preset) => preset.id === presetId);
    if (index === -1) throw new Error(`Unknown custom preset: ${presetId}`);
    this.customPresets.splice(index, 1);
    saveCustomPresets(this.customPresets);
    if (this.config.presetId === presetId) this.config.presetId = "custom";
    this.scheduleSave();
    this.emitStatus();
  }

  setEffects(patch: Partial<DspParams>): void {
    this.config.effects = mergeEffects(this.config.effects, patch);
    this.config.presetId = "custom";
    this.dsp.setParams(this.config.effects);
    this.scheduleSave();
    this.emitStatus();
  }

  setBypass(bypass: boolean): void {
    this.config.effects = { ...this.config.effects, effectsEnabled: !bypass };
    this.dsp.setParams(this.config.effects);
    this.scheduleSave();
    this.emitStatus();
  }

  setBufferMs(ms: number): void {
    if (!Number.isFinite(ms)) throw new Error("Invalid buffer size");
    this.config.targetBufferMs = Math.min(MAX_BUFFER_MS, Math.max(MIN_BUFFER_MS, Math.round(ms)));
    this.targetFrames = Math.round((this.config.targetBufferMs * this.sampleRate) / 1000);
    if (this.queue.frames > this.targetFrames * 4) this.queue.trimTo(this.targetFrames * 2);
    this.scheduleSave();
    this.emitStatus();
  }

  setAutoGain(enabled: boolean): void {
    this.config.autoGain = enabled;
    this.scheduleSave();
    this.emitStatus();
  }

  setOutputDevice(deviceName: string | null): void {
    this.config.outputDeviceName = deviceName;
    this.queue.clear();
    this.outputPrimed = false;
    this.capture.stop();
    this.output.stop();
    this.setSampleRate(this.output.preferredRate(deviceName));
    this.openOutput();
    void this.pollSpotify();
    this.scheduleSave();
    this.emitStatus();
  }

  restart(): void {
    this.captureError = null;
    this.outputError = null;
    this.warning = null;
    this.tapWarning = null;
    this.silencingMode = "none";
    this.spotifyPids = [];
    this.capture.stop();
    this.queue.clear();
    this.assembler.reset();
    this.outputPrimed = false;
    this.firstPacketAt = 0;
    this.hasProcessedAudio = false;
    this.driftIntegral = 0;
    this.smoothedFillFrames = 0;
    this.driftSettled = true;
    void this.pollSpotify();
    this.emitStatus();
  }

  private refreshDevices(): void {
    try {
      this.devices = this.output.listDevices();
    } catch (error) {
      this.devices = [];
      this.outputError = errorMessage(error);
    }
  }

  private openOutput(): void {
    try {
      const result = this.output.open(
        this.config.outputDeviceName,
        this.sampleRate,
        (frames) => this.onOutputFrame(frames),
        (message) => {
          this.outputError = message;
          this.emitStatus();
        },
      );
      if (result.sampleRate !== this.sampleRate) {
        this.setSampleRate(result.sampleRate);
      }
      this.outputDeviceName = result.device.name;
      this.outputSilence = silentPcm(result.frameSize);
      this.warning = result.warning;
      this.outputError = null;
      this.refreshDevices();
    } catch (error) {
      this.outputError = errorMessage(error);
      this.outputDeviceName = null;
    }
  }

  private setSampleRate(rate: number): void {
    const next =
      Number.isFinite(rate) && rate >= 8_000 && rate <= 192_000
        ? Math.round(rate)
        : DEFAULT_SAMPLE_RATE;
    if (next === this.sampleRate) return;
    this.sampleRate = next;
    this.captureSampleRate = next;
    this.targetFrames = Math.round((this.config.targetBufferMs * next) / 1_000);
    this.dsp = new DspChain(next, this.config.effects, DSP_BLOCK_FRAMES);
    this.outputSilence = silentPcm(Math.round((next * OUTPUT_BLOCK_MS) / 1_000));
    this.queue.clear();
    this.outputPrimed = false;
    this.smoothedFillFrames = 0;
    this.driftIntegral = 0;
    this.driftSettled = true;
    if (this.capture.active) {
      const pid = this.capture.pid;
      this.capture.stop();
      if (pid !== null) this.startCapture(pid);
    }
  }

  private onOutputFrame(frames: number): Buffer {
    if (!this.outputPrimed) {
      if (this.queue.frames >= this.targetFrames) {
        this.outputPrimed = true;
        this.smoothedFillFrames = this.queue.frames;
      } else {
        return this.silence(frames);
      }
    }
    const ratio = this.driftRatio();
    const read = this.queue.read(frames, ratio);
    if (read.missingFrames > 0) {
      this.underruns += 1;
      this.outputPrimed = false;
    }
    return interleavedToBuffer(read.data);
  }

  private driftRatio(): number {
    const target = Math.max(1, this.targetFrames);
    if (this.smoothedFillFrames === 0) this.smoothedFillFrames = this.queue.frames;
    this.smoothedFillFrames += (this.queue.frames - this.smoothedFillFrames) * 0.05;
    const error = (this.smoothedFillFrames - target) / target;
    if (Math.abs(error) < 0.12) {
      if (!this.driftSettled) {
        this.queue.settleToUnity();
        this.driftSettled = true;
        this.driftIntegral = 0;
      }
      return 1;
    }
    this.driftSettled = false;
    this.driftIntegral += error * 0.0002;
    this.driftIntegral = Math.min(0.01, Math.max(-0.01, this.driftIntegral));
    const correction = error * 0.004 + this.driftIntegral;
    return Math.min(1.01, Math.max(0.99, 1 + correction));
  }

  private silence(frames: number): Buffer {
    if (this.outputSilence.length !== frames * OUTPUT_FRAME_BYTES) {
      this.outputSilence = silentPcm(frames);
    }
    return this.outputSilence;
  }

  private async pollSpotify(): Promise<void> {
    if (this.stopping) return;
    try {
      const pids = await findSpotifyPids(this.config.spotifyImageName);
      if (this.stopping) return;
      this.spotifyPids = pids;
      const rootPid = pids[0] ?? null;

      if (rootPid === null) {
        if (this.capture.active) this.stopCapture();
        this.captureError = null;
        this.emitStatus();
        return;
      }

      if (!this.capture.active) {
        this.startCapture(rootPid);
      } else {
        const currentPid = this.capture.pid;
        const terminalError = this.capture.lastError;
        if (terminalError) {
          this.captureError = terminalError;
          this.stopCapture();
          this.startCapture(rootPid);
        } else if (currentPid === null || !pids.includes(currentPid)) {
          this.stopCapture();
          this.startCapture(rootPid);
        }
      }
    } catch (error) {
      this.captureError = errorMessage(error);
      this.emitStatus();
    }
  }

  private startCapture(pid: number): void {
    if (!this.capture.supportsFloat32) {
      this.captureError =
        "The bundled loopback-capture fork is required. Run `npm run build:capture`.";
      this.emitStatus();
      return;
    }
    this.captureFormat = "f32";
    this.captureSampleRate = this.sampleRate;
    this.assembler = new BlockAssembler(DSP_BLOCK_FRAMES, this.captureFormat);
    this.queue.clear();
    this.outputPrimed = false;
    this.firstPacketAt = 0;
    this.lastCaptureAt = Date.now();
    this.lastChunkCount = 0;
    this.hasProcessedAudio = false;
    this.autoGain = 1;
    this.driftIntegral = 0;
    this.smoothedFillFrames = 0;
    this.driftSettled = true;
    this.tapWarning = null;
    this.silencingMode = "none";
    try {
      if (this.capture.supportsTap) {
        try {
          const started = this.capture.startTap(
            pid,
            (pcm) => {
              this.onCaptureChunk(pcm);
            },
            { format: "f32", sampleRate: this.sampleRate },
          );
          this.captureSampleRate = started.sampleRate;
          this.captureError = null;
          this.silencingMode = "tap";
          this.emitStatus();
          return;
        } catch (tapError) {
          this.tapWarning = `Spotify tap unavailable (${errorMessage(tapError)}); using process loopback`;
        }
      }
      const started = this.capture.start(
        pid,
        (pcm) => {
          this.onCaptureChunk(pcm);
        },
        { format: this.captureFormat, sampleRate: this.sampleRate },
      );
      this.captureSampleRate = started.sampleRate;
      if (started.format !== this.captureFormat) {
        this.captureFormat = started.format;
        this.assembler.setFormat(started.format);
        this.warning = "Float capture was rejected; falling back to 16-bit";
      }
      this.silencingMode = this.virtualCableDetected() ? "cable" : "none";
      this.captureError = null;
      this.emitStatus();
    } catch (error) {
      this.captureError = errorMessage(error);
      this.capture.stop();
      this.silencingMode = "none";
      this.emitStatus();
    }
  }

  private stopCapture(): void {
    this.assembler.flush((left, right, frames) => {
      this.processBlock(left, right, frames);
    });
    this.capture.stop();
    this.lastCaptureAt = Date.now();
    this.outputPrimed = false;
    this.silencingMode = "none";
    this.emitStatus();
  }

  private onCaptureChunk(pcm: Buffer): void {
    this.lastCaptureAt = Date.now();
    this.lastChunkCount += 1;
    if (this.firstPacketAt === 0) this.firstPacketAt = this.lastCaptureAt;
    this.hasProcessedAudio = true;
    this.assembler.push(pcm, (left, right, frames) => {
      this.processBlock(left, right, frames);
    });
  }

  private processBlock(left: Float32Array, right: Float32Array, frames: number): void {
    if (this.config.effects.effectsEnabled) {
      let inputPower = 0;
      for (let index = 0; index < frames; index += 1) {
        inputPower += (left[index]! ** 2 + right[index]! ** 2) * 0.5;
      }
      this.updateAutoGain(Math.sqrt(inputPower / Math.max(1, frames)));
      const gain = this.autoGain;
      if (gain !== 1) {
        for (let index = 0; index < frames; index += 1) {
          left[index] = left[index]! * gain;
          right[index] = right[index]! * gain;
        }
      }
    } else {
      this.autoGain += (1 - this.autoGain) * 0.05;
    }
    this.dsp.processBlock(left, right, frames);
    this.updateLevel(left, right, frames);
    this.queue.pushInterleaved(left, right, frames);
    const maxFrames = Math.max(
      this.targetFrames * 4,
      this.targetFrames + Math.round(this.sampleRate * 0.05),
    );
    if (this.queue.frames > maxFrames) {
      this.overruns += 1;
      this.droppedFrames += this.queue.trimTo(this.targetFrames * 2);
    }
  }

  private updateAutoGain(inputRms: number): void {
    if (!this.config.autoGain) {
      this.autoGain += (1 - this.autoGain) * 0.05;
      return;
    }
    if (inputRms < 0.0002) return;
    const targetRms = 0.1;
    const maxGain = Math.pow(10, MAX_AUTO_GAIN_DB / 20);
    const desired = Math.min(maxGain, Math.max(0.25, targetRms / inputRms));
    this.autoGain += (desired - this.autoGain) * 0.003;
  }

  private updateLevel(left: Float32Array, right: Float32Array, frames: number): void {
    let peak = 0;
    let power = 0;
    for (let index = 0; index < frames; index += 1) {
      const leftSample = left[index]!;
      const rightSample = right[index]!;
      const magnitude = Math.max(Math.abs(leftSample), Math.abs(rightSample));
      if (magnitude > peak) peak = magnitude;
      power += (leftSample * leftSample + rightSample * rightSample) * 0.5;
    }
    power /= Math.max(1, frames);
    this.smoothedPeak += (peak - this.smoothedPeak) * (peak > this.smoothedPeak ? 0.55 : 0.08);
    this.smoothedPower += (power - this.smoothedPower) * 0.15;
  }

  private pumpTail(): void {
    if (this.stopping || !this.hasProcessedAudio) return;
    const now = Date.now();
    const silenceFor = now - this.lastCaptureAt;
    if (silenceFor < SILENCE_AFTER_MS || silenceFor > TAIL_LIFETIME_MS) return;
    if (this.queue.frames >= this.targetFrames) return;
    let remaining = Math.max(1, Math.round((this.sampleRate * TAIL_INTERVAL_MS) / 1_000));
    while (remaining > 0) {
      const frames = Math.min(DSP_BLOCK_FRAMES, remaining);
      this.zeroLeft.fill(0);
      this.zeroRight.fill(0);
      this.processBlock(this.zeroLeft, this.zeroRight, frames);
      remaining -= frames;
      if (this.queue.frames >= this.targetFrames) break;
    }
  }

  private tick(): void {
    if (this.capture.active && this.capture.lastError) {
      this.captureError = this.capture.lastError;
      this.capture.stop();
      this.outputPrimed = false;
      this.queue.clear();
    }
    this.emitStatus();
  }

  private phase(): EnginePhase {
    if (this.outputError) return "error";
    if (this.captureError && !this.capture.active) return "error";
    if (!this.capture.active) return "waiting-for-spotify";
    if (this.outputPrimed) return "running";
    if (this.lastChunkCount === 0 && Date.now() - this.lastCaptureAt > 1_500) {
      return "waiting-for-spotify";
    }
    return "buffering";
  }

  private status(): EngineStatus {
    const level = this.level();
    const lastError = this.outputError ?? this.captureError;
    const phase = this.phase();
    const waitingMessage =
      this.spotifyPids.length > 0
        ? "Spotify is open; start a track"
        : "Open Spotify and start playback";
    const message =
      lastError ??
      this.tapWarning ??
      this.warning ??
      (phase === "running"
        ? "Processing Spotify"
        : phase === "buffering"
          ? "Buffering Spotify audio"
          : phase === "waiting-for-spotify"
            ? waitingMessage
            : this.config.effects.effectsEnabled
              ? "Open Spotify and start playback"
              : "Bypassed");
    return {
      phase,
      message,
      spotifyPids: this.spotifyPids,
      capturePid: this.capture.pid,
      captureActive: this.capture.active,
      outputActive: this.outputDeviceName !== null,
      outputDeviceName: this.outputDeviceName,
      sampleRate: this.sampleRate,
      captureSampleRate: this.captureSampleRate,
      captureFormat: this.captureFormat,
      bufferMs: Math.round((this.queue.frames / this.sampleRate) * 1000),
      targetBufferMs: this.config.targetBufferMs,
      level,
      underruns: this.underruns,
      overruns: this.overruns,
      droppedChunks: this.droppedFrames,
      lastError,
      autoGainDb: Math.round(20 * Math.log10(this.autoGain) * 10) / 10,
      virtualCableDetected: this.virtualCableDetected(),
      silencingMode: this.silencingMode,
      uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
    };
  }

  private level(): AudioLevel {
    return {
      peakDb: linearToDb(this.smoothedPeak),
      rmsDb: linearToDb(Math.sqrt(this.smoothedPower)),
    };
  }

  private virtualCableDetected(): boolean {
    return this.devices.some((device) =>
      /cable input|vb-audio|voicemeeter.*input|virtual cable/i.test(device.name),
    );
  }

  private emitStatus(): void {
    this.emit("status", this.status());
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 400);
    this.saveTimer.unref();
  }

  private save(): void {
    try {
      saveConfig(this.config);
    } catch (error) {
      this.warning = `Could not save config: ${errorMessage(error)}`;
    }
  }
}

function linearToDb(value: number): number {
  if (value <= 0.0000001) return -90;
  return Math.max(-90, Math.min(0, 20 * Math.log10(value)));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const CUSTOM_PRESET_ACCENTS = [
  "#f43f8f",
  "#38bdf8",
  "#a78bfa",
  "#fbbf24",
  "#a3e635",
  "#fb7185",
  "#22d3ee",
  "#c084fc",
];

function customPresetAccent(name: string): string {
  let hash = 0;
  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 31 + name.charCodeAt(index)) >>> 0;
  }
  return CUSTOM_PRESET_ACCENTS[hash % CUSTOM_PRESET_ACCENTS.length]!;
}

