import {
  CAPTURE_FRAME_BYTES,
  DSP_BLOCK_FRAMES,
  OUTPUT_FRAME_BYTES,
} from "../shared/types.js";

export class BlockAssembler {
  private readonly blockFrames: number;
  private readonly carryLeft: Float32Array;
  private readonly carryRight: Float32Array;
  private carryLength = 0;

  constructor(blockFrames = DSP_BLOCK_FRAMES) {
    this.blockFrames = blockFrames;
    this.carryLeft = new Float32Array(blockFrames);
    this.carryRight = new Float32Array(blockFrames);
  }

  get pendingFrames(): number {
    return this.carryLength;
  }

  reset(): void {
    this.carryLength = 0;
  }

  push(
    pcm: Buffer,
    onBlock: (left: Float32Array, right: Float32Array, frames: number) => void,
  ): void {
    const frames = Math.floor(pcm.length / CAPTURE_FRAME_BYTES);
    let offset = 0;
    while (offset < frames) {
      const available = this.blockFrames - this.carryLength;
      const count = Math.min(available, frames - offset);
      for (let index = 0; index < count; index += 1) {
        const frameOffset = (offset + index) * CAPTURE_FRAME_BYTES;
        this.carryLeft[this.carryLength + index] = pcm.readInt16LE(frameOffset) / 32768;
        this.carryRight[this.carryLength + index] =
          pcm.readInt16LE(frameOffset + 2) / 32768;
      }
      this.carryLength += count;
      offset += count;
      if (this.carryLength === this.blockFrames) {
        onBlock(this.carryLeft, this.carryRight, this.blockFrames);
        this.carryLength = 0;
      }
    }
  }

  flush(
    onBlock: (left: Float32Array, right: Float32Array, frames: number) => void,
  ): void {
    if (this.carryLength === 0) return;
    for (let index = this.carryLength; index < this.blockFrames; index += 1) {
      this.carryLeft[index] = 0;
      this.carryRight[index] = 0;
    }
    onBlock(this.carryLeft, this.carryRight, this.blockFrames);
    this.carryLength = 0;
  }
}

export function interleave(
  left: Float32Array,
  right: Float32Array,
  frames: number,
): Float32Array {
  const output = new Float32Array(frames * 2);
  for (let index = 0; index < frames; index += 1) {
    output[index * 2] = left[index]!;
    output[index * 2 + 1] = right[index]!;
  }
  return output;
}

export function interleavedToBuffer(samples: Float32Array): Buffer {
  return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
}

export function silentPcm(frames: number, cached?: Buffer): Buffer {
  if (cached && cached.length === frames * OUTPUT_FRAME_BYTES) return cached;
  return Buffer.alloc(frames * OUTPUT_FRAME_BYTES);
}
