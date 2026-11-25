import { DSP_BLOCK_FRAMES, FRAME_BYTES } from "../shared/types.js";

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
    const frames = Math.floor(pcm.length / FRAME_BYTES);
    let offset = 0;
    while (offset < frames) {
      const available = this.blockFrames - this.carryLength;
      const count = Math.min(available, frames - offset);
      for (let index = 0; index < count; index += 1) {
        const frameOffset = (offset + index) * FRAME_BYTES;
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

export function floatToPcm16(
  left: Float32Array,
  right: Float32Array,
  frames: number,
): Buffer {
  const buffer = Buffer.allocUnsafe(frames * FRAME_BYTES);
  if (buffer.byteOffset % 2 === 0) {
    const view = new Int16Array(buffer.buffer, buffer.byteOffset, frames * 2);
    for (let index = 0; index < frames; index += 1) {
      view[index * 2] = toInt16(left[index]!);
      view[index * 2 + 1] = toInt16(right[index]!);
    }
  } else {
    for (let index = 0; index < frames; index += 1) {
      buffer.writeInt16LE(toInt16(left[index]!), index * FRAME_BYTES);
      buffer.writeInt16LE(toInt16(right[index]!), index * FRAME_BYTES + 2);
    }
  }
  return buffer;
}

function toInt16(sample: number): number {
  const clamped = Math.max(-1, Math.min(1, sample));
  return Math.max(-32768, Math.min(32767, Math.round(clamped * 32768)));
}

export function silentPcm(frames: number, cached?: Buffer): Buffer {
  if (cached && cached.length === frames * FRAME_BYTES) return cached;
  return Buffer.alloc(frames * FRAME_BYTES);
}
