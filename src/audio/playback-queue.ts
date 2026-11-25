import { FRAME_BYTES } from "../shared/types.js";

export interface QueueRead {
  data: Buffer;
  missingFrames: number;
}

export class PlaybackQueue {
  private chunks: Buffer[] = [];
  private headOffset = 0;
  private totalBytes = 0;

  get frames(): number {
    return Math.floor(this.totalBytes / FRAME_BYTES);
  }

  get bytes(): number {
    return this.totalBytes;
  }

  push(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.totalBytes += chunk.length;
  }

  read(frames: number): QueueRead {
    const requestedBytes = frames * FRAME_BYTES;
    const output = Buffer.alloc(requestedBytes);
    let copied = 0;
    while (copied < requestedBytes && this.chunks.length > 0) {
      const head = this.chunks[0]!;
      const available = head.length - this.headOffset;
      const needed = requestedBytes - copied;
      const count = Math.min(available, needed);
      head.copy(output, copied, this.headOffset, this.headOffset + count);
      copied += count;
      this.headOffset += count;
      this.totalBytes -= count;
      if (this.headOffset >= head.length) {
        this.chunks.shift();
        this.headOffset = 0;
      }
    }
    const missingFrames = Math.floor((requestedBytes - copied) / FRAME_BYTES);
    return { data: output, missingFrames };
  }

  trimTo(maxFrames: number): number {
    const maxBytes = maxFrames * FRAME_BYTES;
    let droppedFrames = 0;
    while (this.totalBytes > maxBytes && this.chunks.length > 0) {
      const head = this.chunks[0]!;
      const available = head.length - this.headOffset;
      const excess = this.totalBytes - maxBytes;
      const dropBytes = Math.min(available, excess);
      this.headOffset += dropBytes;
      this.totalBytes -= dropBytes;
      droppedFrames += Math.floor(dropBytes / FRAME_BYTES);
      if (this.headOffset >= head.length) {
        this.chunks.shift();
        this.headOffset = 0;
      }
    }
    return droppedFrames;
  }

  clear(): void {
    this.chunks = [];
    this.headOffset = 0;
    this.totalBytes = 0;
  }
}
