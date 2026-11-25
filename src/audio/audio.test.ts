import { describe, expect, it } from "vitest";
import { BlockAssembler, interleave } from "./pcm.js";
import { PlaybackQueue } from "./playback-queue.js";
import { parseTasklist } from "./spotify-discovery.js";
import { CAPTURE_S16_FRAME_BYTES } from "../shared/types.js";

function pcm(frames: number, value: number): Buffer {
  const buffer = Buffer.alloc(frames * CAPTURE_S16_FRAME_BYTES);
  for (let index = 0; index < frames; index += 1) {
    buffer.writeInt16LE(value, index * CAPTURE_S16_FRAME_BYTES);
    buffer.writeInt16LE(value, index * CAPTURE_S16_FRAME_BYTES + 2);
  }
  return buffer;
}

function samples(frames: number, value: number): Float32Array {
  const buffer = new Float32Array(frames * 2);
  buffer.fill(value);
  return buffer;
}

describe("block assembler", () => {
  it("emits fixed-size blocks and pads a flush", () => {
    const assembler = new BlockAssembler(4);
    const blocks: number[] = [];
    assembler.push(pcm(10, 1000), (_left, _right, frames) => blocks.push(frames));
    expect(blocks).toEqual([4, 4]);
    assembler.flush((_left, _right, frames) => blocks.push(frames));
    expect(blocks).toEqual([4, 4, 4]);
    expect(assembler.pendingFrames).toBe(0);
  });

  it("converts signed 16-bit PCM to floats and interleaves float output", () => {
    const assembler = new BlockAssembler(2);
    let captured: { left: number[]; right: number[] } | null = null;
    assembler.push(pcm(2, 16384), (left, right) => {
      captured = { left: [...left], right: [...right] };
    });
    expect(captured).not.toBeNull();
    expect(captured!.left[0]).toBeCloseTo(0.5, 4);
    const output = interleave(new Float32Array([0.5, -0.5]), new Float32Array([0.25, 2]), 2);
    expect(Array.from(output)).toEqual([0.5, 0.25, -0.5, 2]);
  });

  it("reads interleaved float32 capture without conversion loss", () => {
    const assembler = new BlockAssembler(2, "f32");
    const buffer = Buffer.alloc(2 * 8);
    buffer.writeFloatLE(0.25, 0);
    buffer.writeFloatLE(-0.75, 4);
    buffer.writeFloatLE(0.125, 8);
    buffer.writeFloatLE(-0.5, 12);
    let captured: { left: number[]; right: number[] } | null = null;
    assembler.push(buffer, (left, right) => {
      captured = { left: [...left], right: [...right] };
    });
    expect(captured).not.toBeNull();
    expect(captured!.left[0]).toBe(0.25);
    expect(captured!.right[0]).toBe(-0.75);
    expect(captured!.left[1]).toBe(0.125);
    expect(captured!.right[1]).toBe(-0.5);
  });
});

describe("playback queue", () => {
  it("reads across chunks and reports missing frames", () => {
    const queue = new PlaybackQueue();
    queue.push(samples(960, 0.25));
    const first = queue.read(480);
    expect(first.missingFrames).toBe(0);
    expect(first.data.length).toBe(480 * 2);
    expect(first.data[0]).toBeCloseTo(0.25, 5);
    const second = queue.read(480);
    expect(second.missingFrames).toBe(0);
    const missing = queue.read(480);
    expect(missing.missingFrames).toBe(480);
    expect(missing.data.length).toBe(480 * 2);
    expect(missing.data[0]).toBe(0);
  });

  it("trims oldest audio above the latency cap", () => {
    const queue = new PlaybackQueue();
    queue.push(samples(4_800, 1));
    const dropped = queue.trimTo(1_920);
    expect(dropped).toBe(2_880);
    expect(queue.frames).toBe(1_920);
  });

  it("reads with a small drift ratio without failing", () => {
    const queue = new PlaybackQueue();
    queue.push(samples(4_800, 0.5));
    const read = queue.read(1_000, 1.0005);
    expect(read.missingFrames).toBe(0);
    expect(read.data.length).toBe(2_000);
    for (const sample of read.data) {
      expect(Number.isFinite(sample)).toBe(true);
      expect(Math.abs(sample - 0.5)).toBeLessThan(1e-6);
    }
  });

  it("returns exact samples at unity ratio", () => {
    const queue = new PlaybackQueue();
    const ramp = new Float32Array(2_000);
    for (let index = 0; index < 1_000; index += 1) {
      ramp[index * 2] = index / 1_000;
      ramp[index * 2 + 1] = -index / 1_000;
    }
    queue.push(ramp);
    const read = queue.read(500);
    expect(read.missingFrames).toBe(0);
    for (let index = 0; index < 500; index += 1) {
      expect(read.data[index * 2]).toBeCloseTo(index / 1_000, 6);
      expect(read.data[index * 2 + 1]).toBeCloseTo(-index / 1_000, 6);
    }
  });

  it("preserves a 15 kHz tone through fractional drift correction", () => {
    const queue = new PlaybackQueue();
    const frames = 4_800;
    const samples = new Float32Array(frames * 2);
    for (let index = 0; index < frames; index += 1) {
      const sample = Math.sin((2 * Math.PI * 15_000 * index) / 48_000) * 0.5;
      samples[index * 2] = sample;
      samples[index * 2 + 1] = sample;
    }
    queue.push(samples);
    const read = queue.read(2_000, 1.0005);
    expect(read.missingFrames).toBe(0);
    const power = (data: Float32Array, startFrame: number, endFrame: number) => {
      let sum = 0;
      let count = 0;
      for (let frame = startFrame; frame < endFrame; frame += 1) {
        const value = data[frame * 2]!;
        sum += value * value;
        count += 1;
      }
      return Math.sqrt(sum / count);
    };
    const ratio = power(read.data, 100, 1_900) / power(samples, 200, 2_000);
    expect(ratio).toBeGreaterThan(0.95);
    expect(ratio).toBeLessThan(1.05);
  });

  it("settles back to exact grid reads", () => {
    const queue = new PlaybackQueue();
    queue.push(samples(9_600, 0.25));
    queue.read(1_000, 1.0005);
    queue.settleToUnity();
    for (let attempt = 0; attempt < 5 && !queue.aligned; attempt += 1) {
      const read = queue.read(1_000);
      expect(read.missingFrames).toBe(0);
    }
    expect(queue.aligned).toBe(true);
    const read = queue.read(100);
    expect(read.missingFrames).toBe(0);
    for (const sample of read.data) expect(sample).toBeCloseTo(0.25, 5);
  });

  it("grows when the queue exceeds its initial capacity", () => {
    const queue = new PlaybackQueue(64);
    for (let index = 0; index < 10; index += 1) queue.push(samples(64, index / 10));
    expect(queue.frames).toBe(640);
    const read = queue.read(640);
    expect(read.missingFrames).toBe(0);
  });
});

describe("spotify discovery parsing", () => {
  it("finds Spotify PIDs in tasklist CSV output", () => {
    const output = [
      '"Spotify.exe","4312","Console","1","120,000 K"',
      '"Spotify.exe","4312","Console","1","120,000 K"',
      '"NotSpotify.exe","9999","Console","1","1 K"',
      '"spotify.exe","888","Console","1","1 K"',
    ].join("\r\n");
    expect(parseTasklist(output, "Spotify.exe")).toEqual([888, 4312]);
  });

  it("ignores localized no-task messages", () => {
    expect(parseTasklist("INFO: No tasks are running which match the specified criteria.\r\n", "Spotify.exe")).toEqual([]);
  });
});
