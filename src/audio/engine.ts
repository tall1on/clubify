import { EventEmitter } from "node:events";
import { DspChain } from "../dsp/chain.js";
import {
  DEFAULT_BUFFER_MS,
  DEFAULT_SAMPLE_RATE,
  DSP_BLOCK_FRAMES,
  MAX_AUTO_GAIN_DB,
  MAX_BUFFER_MS,
  MIN_BUFFER_MS,
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
const PUMP_INTERVAL_MS = 4;
const TAIL_INTERVAL_MS = 10;
const STARTUP_TRIM_MS = 1_500;
const DEVICE_CACHE_MS = 5_000;
const OUTPUT_REOPEN_MS = 2_000;
const TAIL_MAX_MS = 8_000;
const RESAMPLER_MARGIN_FRAMES = 64;
// Drift correction only exists to track clock difference between Spotify and
// the output device, which is tens of ppm. Bending pitch even briefly is much
// more noticeable than a slightly slower buffer-level correction.
const DRIFT_LIMIT = 0.001;
const DRIFT_PROPORTIONAL_GAIN = 0.002;
const DRIFT_INTEGRAL_GAIN = 0.0006;

interface CaptureDeliveryStats {
  deliveredPackets: number;
  deliveredBytes: number;
  droppedPackets: number;
  droppedBytes: number;
}

interface NativeOutputStats {
  fillFrames: number;
  capacityFrames: number;
  underruns: number;
  silentFrames: number;
  droppedFrames: number;
  fatal: string | null;
}

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
  private pumpScratch = new Float32Array(DSP_BLOCK_FRAMES * 2);
  private silencePush: Buffer = Buffer.alloc(0);

  private devices: OutputDevice[] = [];
  private devicesRefreshedAt = 0;
  private outputDeviceName: string | null = null;
  private sampleRate = DEFAULT_SAMPLE_RATE;
  private captureSampleRate = DEFAULT_SAMPLE_RATE;
  private captureFormat: CaptureFormat = "f32";
  private targetFrames: number;
  private maxPushFrames: number;
  private discoveryTimer: NodeJS.Timeout | null = null;
  private statusTimer: NodeJS.Timeout | null = null;
  private tailTimer: NodeJS.Timeout | null = null;
  private pumpTimer: NodeJS.Timeout | null = null;
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
  private overruns = 0;
  private droppedFrames = 0;
  private smoothedPeak = 0;
  private smoothedPower = 0;
  private firstPacketAt = 0;
  private autoGain = 1;
  private driftIntegral = 0;
  private smoothedBufferedFrames = 0;
  private driftSettled = true;
  private lastDriftAt = 0;
  private lastTailAt = 0;
  private tailActive = false;
  private tailStartedAt = 0;
  private tailExhausted = false;
  private deviceListError: string | null = null;
  private lastDefaultFollowAt = 0;
  private nativeStats: NativeOutputStats | null = null;
  private captureStats: CaptureDeliveryStats | null = null;
  private lastOutputReopenAt = 0;

  constructor(config: AppConfig) {
    super();
    this.config = config;
    this.customPresets = loadCustomPresets();
    this.targetFrames = Math.round((config.targetBufferMs * this.sampleRate) / 1000);
    this.maxPushFrames = this.computeMaxPushFrames();
    this.dsp = new DspChain(this.sampleRate, config.effects, DSP_BLOCK_FRAMES);
  }

  get configSnapshot(): AppConfig {
    return this.config;
  }

  async start(): Promise<void> {
    this.stopping = false;
    this.refreshDevices(true);
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
    this.pumpTimer = setInterval(() => {
      this.pumpOutput();
    }, PUMP_INTERVAL_MS);
    this.pumpTimer.unref();
    await this.pollSpotify();
    this.emitStatus();
  }

  stop(): void {
    this.stopping = true;
    if (this.discoveryTimer) clearInterval(this.discoveryTimer);
    if (this.statusTimer) clearInterval(this.statusTimer);
    if (this.tailTimer) clearInterval(this.tailTimer);
    if (this.pumpTimer) clearInterval(this.pumpTimer);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.discoveryTimer = null;
    this.statusTimer = null;
    this.tailTimer = null;
    this.pumpTimer = null;
    this.saveTimer = null;
    this.capture.stop();
    this.output.stop();
    this.queue.clear();
    this.save();
  }

  getState(_refreshDevices = false): PublicState {
    // The list is cached: rescanning WASAPI endpoints must never sit between a
    // UI connect and audio processing. Explicit device changes force a refresh.
    this.refreshDevices();
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
    if (this.queue.frames > this.targetFrames * 2) this.queue.trimTo(this.targetFrames);
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
    this.nativeStats = null;
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
    this.firstPacketAt = 0;
    this.hasProcessedAudio = false;
    this.resetDrift();
    void this.pollSpotify();
    this.emitStatus();
  }

  private refreshDevices(force = false): void {
    const now = Date.now();
    if (!force && this.devices.length > 0 && now - this.devicesRefreshedAt < DEVICE_CACHE_MS) {
      return;
    }
    if (!this.output.supported) {
      this.devices = [];
      return;
    }
    try {
      this.devices = this.output.listDevices();
      this.devicesRefreshedAt = now;
      this.deviceListError = null;
    } catch (error) {
      // Device enumeration failure is not an output-stream failure: reopening
      // a healthy stream on a transient list error would cause a dropout.
      this.devicesRefreshedAt = now;
      this.deviceListError = errorMessage(error);
    }
  }

  private openOutput(): void {
    if (!this.output.supported) {
      this.outputError =
        "The native audio output is missing. Run `npm run build:capture` and restart.";
      this.outputDeviceName = null;
      return;
    }
    try {
      const result = this.output.open(this.config.outputDeviceName, this.sampleRate);
      this.outputDeviceName = result.device.name;
      this.warning = result.warning;
      this.outputError = null;
      this.nativeStats = null;
      this.allocatePumpScratch();
      this.primeOutput();
      this.refreshDevices(true);
    } catch (error) {
      this.outputError = errorMessage(error);
      this.outputDeviceName = null;
      this.nativeStats = null;
    }
  }

  /**
   * Fills the native ring with silence so opening the stream does not count
   * startup gaps as underruns. The tail pump keeps it topped up until Spotify
   * starts producing real audio.
   */
  private primeOutput(): void {
    const fill = this.output.stats()?.fillFrames ?? 0;
    const frames = Math.max(0, this.targetFrames - fill);
    if (frames > 0) this.output.push(silentPcm(frames));
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
    this.maxPushFrames = this.computeMaxPushFrames();
    this.allocatePumpScratch();
    this.dsp = new DspChain(next, this.config.effects, DSP_BLOCK_FRAMES);
    this.queue.clear();
    this.resetDrift();
    if (this.capture.active) {
      const pid = this.capture.pid;
      this.capture.stop();
      if (pid !== null) this.startCapture(pid);
    }
  }

  /**
   * Push-ahead output: every pump tops the native ring up to the configured
   * buffer with already-processed audio. A stalled event loop therefore eats
   * into the ring instead of triggering an immediate dropout, and the drift
   * controller tracks the total buffered amount.
   */
  private pumpOutput(): void {
    if (this.stopping) return;
    const stats = this.output.stats();
    if (!stats) return;
    this.nativeStats = stats;
    if (stats.fatal) {
      if (this.outputError !== stats.fatal) {
        this.outputError = stats.fatal;
        this.emitStatus();
      }
      return;
    }
    const target = Math.max(1, this.targetFrames);
    const deficit = target - stats.fillFrames;
    if (deficit <= 0) return;
    const chunk = Math.min(deficit, this.maxPushFrames);
    const available = this.queue.frames;
    if (available <= RESAMPLER_MARGIN_FRAMES) {
      // Before any audio exists, or once capture has stopped, keep the ring fed
      // with raw silence. While Spotify is merely paused the processed tail
      // below supplies silence instead, so it must not be preceded by this.
      const paused =
        this.hasProcessedAudio &&
        this.capture.active &&
        Date.now() - this.lastCaptureAt > 150 &&
        stats.fillFrames < (target * 3) / 5;
      if (!this.hasProcessedAudio || !this.capture.active || paused) {
        this.pushSilence(chunk);
      }
      return;
    }
    const ratio = this.driftRatio(stats.fillFrames + available);
    const request = Math.min(deficit, available - RESAMPLER_MARGIN_FRAMES);
    if (request <= 0) return;
    const missing = this.queue.readInto(this.pumpScratch, request, ratio);
    if (missing > 0) return;
    const buffer = interleavedToBuffer(this.pumpScratch.subarray(0, request * 2));
    const dropped = this.output.push(buffer);
    if (dropped > 0) {
      this.overruns += 1;
      this.droppedFrames += dropped;
    }
    this.nativeStats = this.output.stats() ?? this.nativeStats;
  }

  private pushSilence(frames: number): void {
    const needed = frames * OUTPUT_FRAME_BYTES;
    if (this.silencePush.length < needed) {
      this.silencePush = Buffer.alloc(this.maxPushFrames * OUTPUT_FRAME_BYTES);
    }
    const dropped = this.output.push(this.silencePush.subarray(0, needed));
    if (dropped > 0) {
      this.overruns += 1;
      this.droppedFrames += dropped;
    }
    this.nativeStats = this.output.stats() ?? this.nativeStats;
  }

  /**
   * Clock-drift controller. The error is the total buffered audio (native ring
   * plus JS staging queue) against the configured target, so a device clock
   * that is faster than Spotify's is corrected even when the queue itself is
   * empty. The correction is capped at 0.1% because anything more is audible
   * as a pitch shift; real clock difference is measured in ppm.
   */
  private driftRatio(bufferedFrames: number): number {
    const now = Date.now();
    const target = Math.max(1, this.targetFrames);
    const deadband = Math.max(2 * DSP_BLOCK_FRAMES, Math.round(this.sampleRate * 0.008));
    const first = this.lastDriftAt === 0;
    const elapsed = first
      ? 0
      : Math.min(0.25, Math.max(0, (now - this.lastDriftAt) / 1000));
    this.lastDriftAt = now;
    if (first) this.smoothedBufferedFrames = bufferedFrames;
    this.smoothedBufferedFrames += (bufferedFrames - this.smoothedBufferedFrames) * 0.08;
    const error = (this.smoothedBufferedFrames - target) / target;
    const outside = Math.abs(this.smoothedBufferedFrames - target) > deadband;
    if (!outside) {
      // Hold whatever authority the integral already carries (that is the
      // actual clock ratio) and let it decay slowly when it is no longer
      // needed, instead of snapping the pitch back to unity at the edge.
      this.driftIntegral *= Math.exp(-elapsed * 0.5);
      if (Math.abs(this.driftIntegral) < 1e-6) {
        this.driftIntegral = 0;
        if (!this.driftSettled) {
          this.queue.settleToUnity();
          this.driftSettled = true;
        }
        return 1;
      }
      this.driftSettled = false;
      return 1 + this.driftIntegral;
    }
    this.driftSettled = false;
    // Accumulate by elapsed time, not by pump invocation, so the response does
    // not depend on event-loop timer granularity.
    this.driftIntegral += error * elapsed * DRIFT_INTEGRAL_GAIN;
    this.driftIntegral = Math.min(DRIFT_LIMIT, Math.max(-DRIFT_LIMIT, this.driftIntegral));
    const correction = error * DRIFT_PROPORTIONAL_GAIN + this.driftIntegral;
    return 1 + Math.min(DRIFT_LIMIT, Math.max(-DRIFT_LIMIT, correction));
  }

  private resetDrift(): void {
    this.driftIntegral = 0;
    this.smoothedBufferedFrames = 0;
    this.driftSettled = true;
    this.lastDriftAt = 0;
  }

  private computeMaxPushFrames(): number {
    // A single pump may refill the whole configured buffer, so bursty capture
    // delivery cannot outrun the refill rate.
    return Math.max(
      DSP_BLOCK_FRAMES,
      Math.round((this.sampleRate * MAX_BUFFER_MS) / 1_000),
    );
  }

  private allocatePumpScratch(): void {
    const frames = this.computeMaxPushFrames();
    this.maxPushFrames = frames;
    if (this.pumpScratch.length !== frames * 2) {
      this.pumpScratch = new Float32Array(frames * 2);
    }
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
    this.firstPacketAt = 0;
    this.lastCaptureAt = Date.now();
    this.lastChunkCount = 0;
    this.hasProcessedAudio = false;
    this.autoGain = 1;
    this.tailActive = false;
    this.tailExhausted = false;
    this.lastTailAt = 0;
    this.resetDrift();
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
    this.tailActive = false;
    this.tailExhausted = false;
    this.lastTailAt = 0;
    this.silencingMode = "none";
    this.emitStatus();
  }

  private onCaptureChunk(pcm: Buffer): void {
    this.lastCaptureAt = Date.now();
    this.lastChunkCount += 1;
    this.tailActive = false;
    this.tailExhausted = false;
    this.lastTailAt = 0;
    if (this.firstPacketAt === 0) this.firstPacketAt = this.lastCaptureAt;
    if (!this.hasProcessedAudio) {
      // Startup priming and capture switches are not playback dropouts.
      this.output.resetStats();
      this.nativeStats = null;
    }
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
    this.enforceStartupTrim();
    const maxQueued = this.targetFrames + Math.round(this.sampleRate * 0.05);
    if (this.queue.frames > maxQueued + this.targetFrames) {
      this.overruns += 1;
      this.droppedFrames += this.queue.trimTo(maxQueued);
    }
    // Capture wakes the event loop on every packet, so pumping here refills the
    // native ring on real audio cadence instead of a 15 ms-quantized timer.
    this.pumpOutput();
  }

  /**
   * The tap buffers up to 64 ms of audio while it measures Spotify's render
   * rate, then releases it in one burst. Absorbing that burst as buffer depth
   * would raise latency and drive the drift controller for seconds, so the
   * stale head is discarded once, right at stream start.
   */
  private enforceStartupTrim(): void {
    if (this.firstPacketAt === 0) return;
    if (Date.now() - this.firstPacketAt > STARTUP_TRIM_MS) return;
    const allowance = Math.max(2 * DSP_BLOCK_FRAMES, Math.round(this.sampleRate * 0.01));
    const surge = Math.max(4 * DSP_BLOCK_FRAMES, Math.round(this.sampleRate * 0.03));
    if (this.queue.frames > surge) this.queue.trimTo(allowance);
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

  /**
   * Keeps the DSP running on silence while Spotify is paused or between
   * tracks. The native ring fill is the starvation signal: the tail latches on
   * while the ring is below half the target (or no packet has arrived for a
   * while) and stays on until real audio resumes, so the reverb/delay tail
   * decays in real time instead of being cut off, and the ring never drains
   * into a counted underrun.
   */
  private pumpTail(): void {
    if (this.stopping || !this.hasProcessedAudio || !this.capture.active) return;
    if (this.tailExhausted) return;
    const now = Date.now();
    if (!this.tailActive) {
      const stats = this.output.stats();
      if (stats) this.nativeStats = stats;
      const target = Math.max(1, this.targetFrames);
      const fill = stats?.fillFrames ?? 0;
      const hungry = fill < target / 2;
      const quietFor = Math.max(40, Math.round(this.config.targetBufferMs * 0.75));
      const quiet = now - this.lastCaptureAt >= quietFor;
      if (!hungry && !quiet) return;
      this.tailActive = true;
      this.tailStartedAt = now;
      this.lastTailAt = 0;
    }
    if (now - this.tailStartedAt > TAIL_MAX_MS) {
      // The reverb/delay tail has long decayed; stop burning DSP cycles on a
      // paused stream. The pump's idle guard keeps the ring fed with raw
      // silence until real audio returns.
      this.tailActive = false;
      this.tailExhausted = true;
      this.lastTailAt = 0;
      return;
    }
    const elapsedMs =
      this.lastTailAt === 0
        ? TAIL_INTERVAL_MS
        : Math.min(TAIL_INTERVAL_MS * 2, Math.max(TAIL_INTERVAL_MS, now - this.lastTailAt));
    const staging = this.tailStagingFrames();
    // Only enough tail audio to keep the next pump fed; extra silence would
    // become one-time latency that the drift controller takes a minute to shed.
    if (this.queue.frames >= staging) return;
    this.lastTailAt = now;
    let remaining = Math.max(1, Math.round((this.sampleRate * elapsedMs) / 1_000));
    while (remaining > 0) {
      const frames = Math.min(DSP_BLOCK_FRAMES, remaining);
      this.zeroLeft.fill(0);
      this.zeroRight.fill(0);
      this.processBlock(this.zeroLeft, this.zeroRight, frames);
      remaining -= frames;
    }
  }

  private tailStagingFrames(): number {
    return Math.max(2 * DSP_BLOCK_FRAMES, Math.round(this.sampleRate * 0.01));
  }

  private tick(): void {
    if (this.capture.active && this.capture.lastError) {
      this.captureError = this.capture.lastError;
      this.capture.stop();
      this.queue.clear();
    }
    this.captureStats = this.capture.stats();
    this.followDefaultDevice();
    if (this.outputError) {
      const now = Date.now();
      if (this.output.supported && now - this.lastOutputReopenAt >= OUTPUT_REOPEN_MS) {
        this.lastOutputReopenAt = now;
        this.openOutput();
      }
    }
    this.emitStatus();
  }

  /**
   * When the engine is set to "system default", reopening follows a Windows
   * default-device change instead of staying on the old endpoint until restart.
   * Enumeration is TTL-cached, so this costs at most one scan per cache window.
   */
  private followDefaultDevice(): void {
    if (this.outputError) return;
    if (this.config.outputDeviceName !== null || !this.output.isOpen) return;
    if (Date.now() - this.devicesRefreshedAt >= DEVICE_CACHE_MS) {
      this.refreshDevices(true);
    }
    if (Date.now() - this.lastDefaultFollowAt < DEVICE_CACHE_MS) return;
    const defaultDevice = this.devices.find((device) => device.isDefault);
    if (!defaultDevice || !this.outputDeviceName) return;
    if (defaultDevice.name === this.outputDeviceName) return;
    this.lastDefaultFollowAt = Date.now();
    this.queue.clear();
    this.nativeStats = null;
    this.capture.stop();
    this.output.stop();
    this.setSampleRate(this.output.preferredRate(null));
    this.openOutput();
    void this.pollSpotify();
    this.emitStatus();
  }

  private phase(): EnginePhase {
    if (this.outputError) return "error";
    if (this.captureError && !this.capture.active) return "error";
    if (!this.capture.active) return "waiting-for-spotify";
    if (this.hasProcessedAudio && Date.now() - this.lastCaptureAt < 1_000) return "running";
    return "buffering";
  }

  private status(): EngineStatus {
    const level = this.level();
    const lastError =
      this.outputError ??
      this.captureError ??
      (this.devices.length === 0 ? this.deviceListError : null);
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
    const fillFrames = this.nativeStats?.fillFrames ?? 0;
    return {
      phase,
      message,
      spotifyPids: this.spotifyPids,
      capturePid: this.capture.pid,
      captureActive: this.capture.active,
      outputActive: this.output.isOpen,
      outputDeviceName: this.outputDeviceName,
      sampleRate: this.sampleRate,
      captureSampleRate: this.captureSampleRate,
      captureFormat: this.captureFormat,
      bufferMs: Math.round(((this.queue.frames + fillFrames) / this.sampleRate) * 1000),
      targetBufferMs: this.config.targetBufferMs,
      outputFillMs: Math.round((fillFrames / this.sampleRate) * 1000),
      level,
      underruns: this.nativeStats?.underruns ?? 0,
      overruns: this.overruns,
      droppedChunks: this.droppedFrames,
      outputSilentFrames: this.nativeStats?.silentFrames ?? 0,
      captureDroppedPackets: this.captureStats?.droppedPackets ?? 0,
      captureDroppedBytes: this.captureStats?.droppedBytes ?? 0,
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
