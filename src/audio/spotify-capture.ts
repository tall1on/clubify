import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

export interface CaptureDeliveryStats {
  deliveredPackets: number;
  deliveredBytes: number;
  droppedPackets: number;
  droppedBytes: number;
}

const require = createRequire(import.meta.url);
let tapDllPath: string | null | undefined;

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

  /** Delivery and drop counters for the active capture session. */
  stats(): CaptureDeliveryStats | null {
    if (!this.capture?.stats) return null;
    try {
      return this.capture.stats();
    } catch {
      return null;
    }
  }

  get supportsFloat32(): boolean {
    return loopback.supportsFloat32 === true;
  }

  get supportsTap(): boolean {
    return loopback.supportsTap === true;
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

  /**
   * Injects the Spotify tap DLL and reads Spotify's render stream directly.
   * The DLL zeros Spotify's own render buffer while this reader is alive, so
   * no virtual cable or output-device routing is needed.
   */
  startTap(
    pid: number,
    onChunk: CaptureChunkHandler,
    options: CaptureStartOptions,
  ): CaptureStarted {
    this.stop();
    if (!this.supportsTap) {
      throw new Error("This capture build does not include the Spotify tap");
    }
    if (options.format !== "f32") {
      throw new Error("The Spotify tap always captures float32 audio");
    }
    const dllPath = prepareTapDll();
    if (!dllPath) {
      throw new Error(
        "The Spotify tap DLL was not found. Run `npm run build:tap` or reinstall Clubify.",
      );
    }
    const capture = new loopback.LoopbackCapture();
    if (!capture.startTap) {
      throw new Error("This capture build does not expose startTap");
    }
    const started = capture.startTap(pid, dllPath, onChunk, options.sampleRate);
    this.capture = capture;
    this.activePid = pid;
    return { format: "f32", sampleRate: started.sampleRate };
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

/**
 * The tap DLL is injected into Spotify and therefore locked until Spotify
 * restarts. Inject a content-addressed copy so Clubify updates can replace the
 * bundled DLL without an installer conflict.
 */
function prepareTapDll(): string | null {
  if (tapDllPath !== undefined) return tapDllPath;
  const source = tapDllCandidates().find((candidate) => existsSync(candidate));
  if (!source) return null;
  const bytes = readFileSync(source);
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  const base = process.env.LOCALAPPDATA ?? process.env.TEMP ?? tmpdir();
  const directory = join(base, "Clubify", "tap", hash);
  const target = join(directory, `clubify_spotify_tap_${hash}.dll`);
  if (!existsSync(target)) {
    mkdirSync(directory, { recursive: true });
    copyFileSync(source, target);
  }
  tapDllPath = target;
  return target;
}

function tapDllCandidates(): string[] {
  const candidates: string[] = [];
  if (process.env.CLUBIFY_TAP_DLL) candidates.push(process.env.CLUBIFY_TAP_DLL);
  try {
    const entry = require.resolve("loopback-capture");
    candidates.push(join(dirname(entry), "..", "build", "Release", "clubify_spotify_tap.dll"));
  } catch {
    // The package entry is present in normal installs; keep the dev fallback.
  }
  candidates.push(
    join(process.cwd(), "vendor", "spotify-tap", "target", "release", "clubify_spotify_tap.dll"),
  );
  return candidates;
}
