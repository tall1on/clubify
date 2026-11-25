import { createRequire } from "node:module";
import type { RtAudio as RtAudioInstance } from "audify";
import {
  CHANNELS,
  OUTPUT_BLOCK_FRAMES,
  OUTPUT_BYTES_PER_SAMPLE,
  SAMPLE_RATE,
  type OutputDevice,
} from "../shared/types.js";
import { silentPcm } from "./pcm.js";

const require = createRequire(import.meta.url);
const { RtAudio } = require("audify") as {
  RtAudio: new (api?: number) => RtAudioInstance;
};

const WASAPI_API = 7;
const FLOAT32_FORMAT = 0x10;
const STREAM_FLAGS = 0x2 | 0x8;

type AudifyDevice = ReturnType<RtAudioInstance["getDevices"]>[number];

export interface OpenOutputResult {
  device: OutputDevice;
  warning: string | null;
  frameSize: number;
}

export class WasapiOutput {
  private rt: RtAudioInstance | null = null;
  private running = false;
  private frameSize = OUTPUT_BLOCK_FRAMES;
  private silentFrame: Buffer = Buffer.alloc(
    OUTPUT_BLOCK_FRAMES * CHANNELS * OUTPUT_BYTES_PER_SAMPLE,
  );
  private errorHandler: ((message: string) => void) | null = null;

  listDevices(): OutputDevice[] {
    const rt = new RtAudio(WASAPI_API);
    try {
      return rt
        .getDevices()
        .filter((device: AudifyDevice) => device.outputChannels > 0)
        .map((device: AudifyDevice) => ({
          id: device.id,
          name: device.name,
          isDefault: Boolean(device.isDefaultOutput),
          outputChannels: device.outputChannels,
          preferredSampleRate: device.preferredSampleRate,
        }));
    } finally {
      try {
        if (rt.isStreamOpen()) rt.closeStream();
      } catch {
        // no stream was opened by this probe
      }
    }
  }

  open(
    deviceName: string | null,
    onFrame: (frames: number) => Buffer,
    onError: (message: string) => void,
  ): OpenOutputResult {
    this.stop();
    const rt = new RtAudio(WASAPI_API);
    const devices = rt.getDevices().filter((device: AudifyDevice) => device.outputChannels > 0);
    if (devices.length === 0) {
      throw new Error("No WASAPI output devices are available");
    }
    const defaultId = rt.getDefaultOutputDevice();
    let device: AudifyDevice | undefined;
    let warning: string | null = null;
    if (deviceName) {
      device = devices.find((candidate: AudifyDevice) => candidate.name === deviceName);
      if (!device) {
        warning = `Output device "${deviceName}" was not found; using the system default`;
      }
    }
    if (!device) {
      device =
        devices.find((candidate: AudifyDevice) => candidate.id === defaultId) ?? devices[0]!;
    }
    const frameSize = OUTPUT_BLOCK_FRAMES;
    this.silentFrame = silentPcm(frameSize);
    const actualFrameSize = rt.openStream(
      { deviceId: device.id, nChannels: 2, firstChannel: 0 },
      null,
      FLOAT32_FORMAT,
      SAMPLE_RATE,
      frameSize,
      "clubify",
      null,
      () => this.pullFrame(onFrame),
      STREAM_FLAGS,
      (_type: number, message: string) => {
        if (_type <= 1) return;
        this.errorHandler?.(`${message} (type ${_type})`);
      },
    );
    this.rt = rt;
    this.frameSize = actualFrameSize > 0 ? actualFrameSize : frameSize;
    this.silentFrame = silentPcm(this.frameSize);
    this.errorHandler = onError;
    this.running = true;
    rt.write(this.silentFrame);
    rt.write(this.silentFrame);
    rt.write(this.silentFrame);
    rt.start();
    return {
      device: {
        id: device.id,
        name: device.name,
        isDefault: device.id === defaultId,
        outputChannels: device.outputChannels,
        preferredSampleRate: device.preferredSampleRate,
      },
      warning,
      frameSize: this.frameSize,
    };
  }

  private pullFrame(onFrame: (frames: number) => Buffer): void {
    if (!this.running || !this.rt) return;
    try {
      const frame = onFrame(this.frameSize);
      this.rt.write(frame);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.errorHandler?.(message);
    }
  }

  stop(): void {
    this.running = false;
    const rt = this.rt;
    this.rt = null;
    if (!rt) return;
    try {
      if (rt.isStreamRunning()) rt.stop();
    } catch {
      // ignore driver teardown errors
    }
    try {
      if (rt.isStreamOpen()) rt.closeStream();
    } catch {
      // ignore driver teardown errors
    }
  }
}
