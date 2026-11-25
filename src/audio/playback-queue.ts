const DEFAULT_CAPACITY_FRAMES = 96_000;
const CHANNELS = 2;

export interface QueueRead {
  data: Float32Array;
  missingFrames: number;
}

export class PlaybackQueue {
  private buffer: Float32Array;
  private capacityFrames: number;
  private startFrame = 0;
  private availableFrames = 0;
  private fraction = 0;

  constructor(capacityFrames = DEFAULT_CAPACITY_FRAMES) {
    this.capacityFrames = capacityFrames;
    this.buffer = new Float32Array(capacityFrames * CHANNELS);
  }

  get frames(): number {
    return this.availableFrames;
  }

  get bytes(): number {
    return this.availableFrames * CHANNELS * 4;
  }

  push(samples: Float32Array): void {
    const frames = Math.floor(samples.length / CHANNELS);
    if (frames === 0) return;
    this.ensureCapacity(this.availableFrames + frames);
    const writeStart = (this.startFrame + this.availableFrames) % this.capacityFrames;
    const firstFrames = Math.min(frames, this.capacityFrames - writeStart);
    const firstSamples = firstFrames * CHANNELS;
    this.buffer.set(samples.subarray(0, firstSamples), writeStart * CHANNELS);
    if (firstFrames < frames) {
      this.buffer.set(samples.subarray(firstSamples), 0);
    }
    this.availableFrames += frames;
  }

  read(frames: number, ratio = 1): QueueRead {
    const sampleCount = frames * CHANNELS;
    const output = new Float32Array(sampleCount);
    const required = Math.ceil((frames - 1) * ratio) + 1;
    if (required > this.availableFrames) {
      return { data: output, missingFrames: frames };
    }

    for (let frame = 0; frame < frames; frame += 1) {
      const base = Math.floor(this.fraction);
      const t = this.fraction - base;
      const frameCount = this.availableFrames;
      for (let channel = 0; channel < CHANNELS; channel += 1) {
        const p0 = this.sampleAt(base - 1, channel, frameCount);
        const p1 = this.sampleAt(base, channel, frameCount);
        const p2 = this.sampleAt(base + 1, channel, frameCount);
        const p3 = this.sampleAt(base + 2, channel, frameCount);
        output[frame * CHANNELS + channel] = cubic(p0, p1, p2, p3, t);
      }
      this.fraction += ratio;
      const advance = Math.floor(this.fraction);
      if (advance > 0) {
        this.startFrame = (this.startFrame + advance) % this.capacityFrames;
        this.availableFrames -= advance;
        this.fraction -= advance;
      }
    }

    return { data: output, missingFrames: 0 };
  }

  trimTo(maxFrames: number): number {
    if (this.availableFrames <= maxFrames) return 0;
    const drop = this.availableFrames - maxFrames;
    this.startFrame = (this.startFrame + drop) % this.capacityFrames;
    this.availableFrames = maxFrames;
    return drop;
  }

  clear(): void {
    this.startFrame = 0;
    this.availableFrames = 0;
    this.fraction = 0;
  }

  private sampleAt(offset: number, channel: number, frameCount: number): number {
    let index = offset;
    if (index < -1) index = -1;
    if (index >= frameCount) index = frameCount - 1;
    const ringIndex = (this.startFrame + index + this.capacityFrames) % this.capacityFrames;
    return this.buffer[ringIndex * CHANNELS + channel]!;
  }

  private ensureCapacity(frames: number): void {
    if (frames <= this.capacityFrames) return;
    let capacity = this.capacityFrames;
    while (capacity < frames) capacity *= 2;
    const next = new Float32Array(capacity * CHANNELS);
    for (let frame = 0; frame < this.availableFrames; frame += 1) {
      const ringIndex = (this.startFrame + frame) % this.capacityFrames;
      const source = ringIndex * CHANNELS;
      next[frame * CHANNELS] = this.buffer[source]!;
      next[frame * CHANNELS + 1] = this.buffer[source + 1]!;
    }
    this.buffer = next;
    this.capacityFrames = capacity;
    this.startFrame = 0;
  }
}

function cubic(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const a = 2 * p1;
  const b = p2 - p0;
  const c = 2 * p0 - 5 * p1 + 4 * p2 - p3;
  const d = 3 * (p1 - p2) + p3 - p0;
  return 0.5 * (a + b * t + c * t * t + d * t * t * t);
}
