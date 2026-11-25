import loopback, { type LoopbackCapture } from "loopback-capture";

export type CaptureChunkHandler = (pcm: Buffer) => void;

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

  start(pid: number, onChunk: CaptureChunkHandler): void {
    this.stop();
    const capture = new loopback.LoopbackCapture();
    capture.start(pid, onChunk);
    this.capture = capture;
    this.activePid = pid;
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
