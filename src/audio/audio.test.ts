import { describe, expect, it } from "vitest";
import { BlockAssembler, floatToPcm16 } from "./pcm.js";
import { PlaybackQueue } from "./playback-queue.js";
import { parseTasklist } from "./spotify-discovery.js";
import { FRAME_BYTES } from "../shared/types.js";

function pcm(frames: number, value: number): Buffer {
  const buffer = Buffer.alloc(frames * FRAME_BYTES);
  for (let index = 0; index < frames; index += 1) {
    buffer.writeInt16LE(value, index * FRAME_BYTES);
    buffer.writeInt16LE(value, index * FRAME_BYTES + 2);
  }
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

  it("converts signed 16-bit PCM to floats and back", () => {
    const assembler = new BlockAssembler(2);
    let captured: { left: number[]; right: number[] } | null = null;
    assembler.push(pcm(2, 16384), (left, right) => {
      captured = { left: [...left], right: [...right] };
    });
    expect(captured).not.toBeNull();
    expect(captured!.left[0]).toBeCloseTo(0.5, 4);
    const output = floatToPcm16(new Float32Array([0.5, -0.5]), new Float32Array([0.25, 2]), 2);
    expect(output.readInt16LE(0)).toBe(16384);
    expect(output.readInt16LE(2)).toBe(8192);
    expect(output.readInt16LE(4)).toBe(-16384);
    expect(output.readInt16LE(6)).toBe(32767);
  });
});

describe("playback queue", () => {
  it("reads across chunks and reports missing frames", () => {
    const queue = new PlaybackQueue();
    queue.push(pcm(960, 1));
    const first = queue.read(480);
    expect(first.missingFrames).toBe(0);
    expect(first.data.length).toBe(480 * FRAME_BYTES);
    const second = queue.read(480);
    expect(second.missingFrames).toBe(0);
    const missing = queue.read(480);
    expect(missing.missingFrames).toBe(480);
    expect(missing.data.length).toBe(480 * FRAME_BYTES);
  });

  it("trims oldest audio above the latency cap", () => {
    const queue = new PlaybackQueue();
    queue.push(pcm(4800, 1));
    const dropped = queue.trimTo(1_920);
    expect(dropped).toBe(2_880);
    expect(queue.frames).toBe(1_920);
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
