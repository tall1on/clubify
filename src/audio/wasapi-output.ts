import { createRequire } from "node:module";
import { DEFAULT_SAMPLE_RATE, type OutputDevice } from "../shared/types.js";

interface NativeOutputDevice {
  name: string;
  isDefault: boolean;
  channels: number;
  sampleRate: number;
}

interface NativeOpened {
  deviceName: string;
  sampleRate: number;
  periodFrames: number;
  warning: string | null;
}

interface NativeOutputStats {
  fillFrames: number;
  capacityFrames: number;
  underruns: number;
  silentFrames: number;
  droppedFrames: number;
  fatal: string | null;
}

interface NativeAudioOutput {
  open(deviceName: string | null, sampleRate: number): NativeOpened;
  push(buffer: Buffer): number;
  stats(): NativeOutputStats;
  resetStats(): void;
  stop(): void;
  readonly isOpen: boolean;
}

interface NativeModule {
  supportsOutput?: boolean;
  AudioOutput?: new () => NativeAudioOutput;
  listOutputDevices?: () => NativeOutputDevice[];
  preferredOutputRate?: (deviceName: string | null) => number;
}

const require = createRequire(import.meta.url);
const native = require("loopback-capture") as NativeModule;

export interface OpenOutputResult {
  device: OutputDevice;
  warning: string | null;
  sampleRate: number;
  periodFrames: number;
  capacityFrames: number;
}

export interface OutputStats {
  fillFrames: number;
  capacityFrames: number;
  underruns: number;
  silentFrames: number;
  droppedFrames: number;
  fatal: string | null;
}

/**
 * Thin wrapper over the native WASAPI renderer. JavaScript pushes processed
 * blocks into a native ring; the render thread never calls back into V8, so a
 * busy event loop stretches the ring instead of dropping audio silently.
 */
export class WasapiOutput {
  private output: NativeAudioOutput | null = null;

  get supported(): boolean {
    return native.supportsOutput === true && typeof native.AudioOutput === "function";
  }

  get isOpen(): boolean {
    return this.output?.isOpen === true;
  }

  listDevices(): OutputDevice[] {
    if (!this.supported) throw new Error(missingNativeMessage());
    const devices = native.listOutputDevices?.() ?? [];
    return devices.map((device, index) => ({
      id: index,
      name: device.name,
      isDefault: device.isDefault,
      outputChannels: device.channels,
      preferredSampleRate: device.sampleRate,
    }));
  }

  preferredRate(deviceName: string | null): number {
    if (!this.supported) return DEFAULT_SAMPLE_RATE;
    try {
      return validRate(native.preferredOutputRate?.(deviceName) ?? DEFAULT_SAMPLE_RATE);
    } catch {
      return DEFAULT_SAMPLE_RATE;
    }
  }

  open(deviceName: string | null, sampleRate: number): OpenOutputResult {
    if (!this.supported) throw new Error(missingNativeMessage());
    this.stop();
    const output = new native.AudioOutput!();
    const opened = output.open(deviceName, sampleRate);
    this.output = output;
    return {
      device: {
        id: 0,
        name: opened.deviceName,
        isDefault: deviceName === null,
        outputChannels: 2,
        preferredSampleRate: opened.sampleRate,
      },
      warning: opened.warning,
      sampleRate: validRate(opened.sampleRate),
      periodFrames: opened.periodFrames,
      capacityFrames: output.stats().capacityFrames,
    };
  }

  /** Copies interleaved float32 frames into the native ring. */
  push(buffer: Buffer): number {
    return this.output?.push(buffer) ?? 0;
  }

  stats(): OutputStats | null {
    if (!this.output) return null;
    try {
      return this.output.stats();
    } catch {
      return null;
    }
  }

  /** Clears native underrun/overrun counters when real playback begins. */
  resetStats(): void {
    try {
      this.output?.resetStats();
    } catch {
      // ignore a session that is already gone
    }
  }

  stop(): void {
    const output = this.output;
    this.output = null;
    if (!output) return;
    try {
      output.stop();
    } catch {
      // A dead driver leaves the session inert; dropping it is enough.
    }
  }
}

function validRate(rate: number): number {
  return Number.isFinite(rate) && rate >= 8_000 && rate <= 192_000
    ? Math.round(rate)
    : DEFAULT_SAMPLE_RATE;
}

function missingNativeMessage(): string {
  return "The bundled native audio output is missing. Run `npm run build:capture`.";
}
