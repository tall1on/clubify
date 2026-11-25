import { afterEach, describe, expect, it, vi } from "vitest";
import { AudioEngine } from "./engine.js";
import { defaultConfig } from "../server/config-store.js";
import { DSP_BLOCK_FRAMES } from "../shared/types.js";

/**
 * These tests reach into private fields deliberately: the audio path is driven
 * by the native output and Spotify, so the clock and buffer decisions are the
 * only parts that can be exercised deterministically. They cover the audible
 * regressions found in the capture audit (pitch-bending drift correction,
 * startup replay surge, and pause tails counting as underruns).
 */
type EngineInternals = {
  sampleRate: number;
  targetFrames: number;
  firstPacketAt: number;
  hasProcessedAudio: boolean;
  lastCaptureAt: number;
  tailActive: boolean;
  tailExhausted: boolean;
  tailStartedAt: number;
  queue: {
    frames: number;
    pushInterleaved(left: Float32Array, right: Float32Array, frames: number): void;
  };
  capture: object;
  driftRatio(bufferedFrames: number): number;
  enforceStartupTrim(): void;
  pumpTail(): void;
  onCaptureChunk(pcm: Buffer): void;
};

function internals(): EngineInternals & AudioEngine {
  return new AudioEngine(defaultConfig()) as unknown as EngineInternals & AudioEngine;
}

function pushQueue(engine: EngineInternals, ms: number): void {
  const frames = Math.round((engine.sampleRate * ms) / 1000);
  engine.queue.pushInterleaved(
    new Float32Array(frames).fill(0.1),
    new Float32Array(frames).fill(0.1),
    frames,
  );
}

describe("clock drift controller", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("never bends pitch more than 0.1% for a large buffer surplus", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const engine = internals();
    const ratio = engine.driftRatio(engine.targetFrames + engine.sampleRate);
    expect(ratio).toBeGreaterThan(1);
    expect(ratio).toBeLessThanOrEqual(1.001);
  });

  it("never bends pitch more than 0.1% for a drained buffer", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const engine = internals();
    const ratio = engine.driftRatio(0);
    expect(ratio).toBeLessThan(1);
    expect(ratio).toBeGreaterThanOrEqual(0.999);
  });

  it("stays at unity while the buffer is inside the deadband", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const engine = internals();
    expect(engine.driftRatio(engine.targetFrames + DSP_BLOCK_FRAMES)).toBe(1);
  });
});

describe("startup replay trim", () => {
  it("drops the stale head of the measurement flush", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const engine = internals();
    engine.firstPacketAt = Date.now();
    pushQueue(engine, 60);
    engine.enforceStartupTrim();
    const allowance = Math.max(2 * DSP_BLOCK_FRAMES, Math.round(engine.sampleRate * 0.01));
    expect(engine.queue.frames).toBeLessThanOrEqual(allowance);
  });

  it("leaves normal packet-sized depth alone", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const engine = internals();
    engine.firstPacketAt = Date.now();
    pushQueue(engine, 8);
    engine.enforceStartupTrim();
    expect(engine.queue.frames).toBe(Math.round((engine.sampleRate * 8) / 1000));
  });

  it("stops trimming after the startup window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const engine = internals();
    engine.firstPacketAt = Date.now() - 5_000;
    pushQueue(engine, 60);
    const before = engine.queue.frames;
    engine.enforceStartupTrim();
    expect(engine.queue.frames).toBe(before);
  });
});

describe("pause tail", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts feeding processed silence when the ring is hungry", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const engine = internals();
    Object.defineProperty(engine.capture, "active", { get: () => true, configurable: true });
    engine.hasProcessedAudio = true;
    engine.lastCaptureAt = Date.now() - 1_000;
    engine.pumpTail();
    expect(engine.tailActive).toBe(true);
    expect(engine.queue.frames).toBeGreaterThan(0);
  });

  it("releases the DSP after the tail lifetime and stays quiet", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const engine = internals();
    Object.defineProperty(engine.capture, "active", { get: () => true, configurable: true });
    engine.hasProcessedAudio = true;
    engine.lastCaptureAt = Date.now() - 1_000;
    engine.tailActive = true;
    engine.tailStartedAt = Date.now() - 9_000;
    engine.pumpTail();
    expect(engine.tailActive).toBe(false);
    expect(engine.tailExhausted).toBe(true);
    engine.pumpTail();
    expect(engine.tailActive).toBe(false);
  });

  it("resumes the tail when real audio returns", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const engine = internals();
    Object.defineProperty(engine.capture, "active", { get: () => true, configurable: true });
    engine.hasProcessedAudio = true;
    engine.tailExhausted = true;
    engine.lastCaptureAt = Date.now() - 1_000;
    engine.onCaptureChunk(Buffer.alloc(DSP_BLOCK_FRAMES * 8));
    expect(engine.tailExhausted).toBe(false);
  });
});
