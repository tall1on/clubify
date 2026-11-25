import loopback, { type LoopbackCapture } from "loopback-capture";
import { DEFAULT_SAMPLE_RATE, type CaptureFormat } from "../shared/types.js";

export type CaptureChunkHandler = (pcm: Buffer) => void;

export interface CaptureStartOptions {
  format: CaptureFormat;
  sampleRate: number;
}

export interface CaptureStarted {
  format: CaptureFormat;
  sampleRate: number;
}

export class SpotifyCapture {
  private capture: LoopbackCapture | null = null;
  private activePid: number | null = null;

  get pid(): number | null {
    return this.activePid;
  }

  get active(): boolean {
    return this.capture !== null;
  }

  get lastError(): string | null {
    return this.capture?.lastError ?? null;
  }

  get supportsFloat32(): boolean {
    return loopback.supportsFloat32 === true;
  }

  start(
    pid: number,
    onChunk: CaptureChunkHandler,
    options: CaptureStartOptions,
  ): CaptureStarted {
    this.stop();
    const capture = new loopback.LoopbackCapture();
    if (this.supportsFloat32) {
      try {
        capture.startWithFormat(pid, onChunk, options.format, options.sampleRate);
        this.capture = capture;
        this.activePid = pid;
        return options;
      } catch (error) {
        if (options.format !== "f32") throw error;
        // Some endpoints reject float32. Keep the rate and fall back to 16-bit.
        capture.startWithFormat(pid, onChunk, "s16", options.sampleRate);
        this.capture = capture;
        this.activePid = pid;
        return { format: "s16", sampleRate: options.sampleRate };
      }
    }
    capture.start(pid, onChunk);
    this.capture = capture;
    this.activePid = pid;
    return { format: "s16", sampleRate: DEFAULT_SAMPLE_RATE };
  }

  stop(): void {
    const capture = this.capture;
    this.capture = null;
    this.activePid = null;
    if (!capture) return;
    try {
      capture.stop();
    } catch {
      // stop() can throw after a terminal native error; the session is gone either way
    }
  }
}
