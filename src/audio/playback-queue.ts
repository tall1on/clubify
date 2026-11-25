const DEFAULT_CAPACITY_FRAMES = 192_000;
const CHANNELS = 2;
const KERNEL_TAPS = 32;
const KERNEL_PHASES = 256;
const KERNEL_OFFSET = 15;
const KERNEL_HALF_WIDTH = 16;

const KERNELS = buildKernels();

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
  private settling = false;

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

  pushInterleaved(left: Float32Array, right: Float32Array, frames: number): void {
    if (frames <= 0) return;
    this.ensureCapacity(this.availableFrames + frames);
    let writeFrame = (this.startFrame + this.availableFrames) % this.capacityFrames;
    for (let frame = 0; frame < frames; frame += 1) {
      const destination = writeFrame * CHANNELS;
      this.buffer[destination] = left[frame]!;
      this.buffer[destination + 1] = right[frame]!;
      writeFrame += 1;
      if (writeFrame >= this.capacityFrames) writeFrame = 0;
    }
    this.availableFrames += frames;
  }

  read(frames: number, ratio = 1): QueueRead {
    if (ratio !== 1) this.settling = false;
    const effectiveRatio = this.settling && ratio === 1 ? 0.9995 : ratio;
    const output = new Float32Array(frames * CHANNELS);
    if (effectiveRatio === 1 && this.fraction === 0) {
      if (frames > this.availableFrames) {
        return { data: output, missingFrames: frames };
      }
      for (let frame = 0; frame < frames; frame += 1) {
        const source = ((this.startFrame + frame) % this.capacityFrames) * CHANNELS;
        output[frame * CHANNELS] = this.buffer[source]!;
        output[frame * CHANNELS + 1] = this.buffer[source + 1]!;
      }
      this.startFrame = (this.startFrame + frames) % this.capacityFrames;
      this.availableFrames -= frames;
      return { data: output, missingFrames: 0 };
    }

    const required = Math.ceil((frames - 1) * effectiveRatio) + KERNEL_HALF_WIDTH + 2;
    if (required > this.availableFrames) {
      return { data: output, missingFrames: frames };
    }

    for (let frame = 0; frame < frames; frame += 1) {
      const base = Math.floor(this.fraction);
      const phase = Math.floor((this.fraction - base) * KERNEL_PHASES);
      const kernel = KERNELS[Math.min(KERNEL_PHASES - 1, phase)]!;
      const frameCount = this.availableFrames;
      for (let channel = 0; channel < CHANNELS; channel += 1) {
        let sum = 0;
        for (let tap = 0; tap < KERNEL_TAPS; tap += 1) {
          sum += this.sampleAt(base - KERNEL_OFFSET + tap, channel, frameCount) * kernel[tap]!;
        }
        output[frame * CHANNELS + channel] = sum;
      }
      this.fraction += effectiveRatio;
      const advance = Math.floor(this.fraction);
      if (advance > 0) {
        this.startFrame = (this.startFrame + advance) % this.capacityFrames;
        this.availableFrames -= advance;
        this.fraction -= advance;
      }
      if (this.settling && this.fraction < 1e-9) {
        this.fraction = 0;
        this.settling = false;
      }
    }

    return { data: output, missingFrames: 0 };
  }

  /** Glides back to exact sample-grid reads after a drift correction. */
  settleToUnity(): void {
    this.settling = this.fraction !== 0;
  }

  get aligned(): boolean {
    return this.fraction === 0 && !this.settling;
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
    this.settling = false;
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

function buildKernels(): Float32Array[] {
  const kernels: Float32Array[] = [];
  for (let phase = 0; phase < KERNEL_PHASES; phase += 1) {
    const fraction = phase / KERNEL_PHASES;
    const kernel = new Float32Array(KERNEL_TAPS);
    let sum = 0;
    for (let tap = 0; tap < KERNEL_TAPS; tap += 1) {
      const distance = KERNEL_OFFSET - tap + fraction;
      const magnitude = Math.abs(distance);
      const sinc =
        magnitude < 1e-9 ? 1 : Math.sin(Math.PI * distance) / (Math.PI * distance);
      let window = 0;
      if (magnitude < KERNEL_HALF_WIDTH) {
        const angle = (Math.PI * distance) / KERNEL_HALF_WIDTH;
        window = 0.42 + 0.5 * Math.cos(angle) + 0.08 * Math.cos(2 * angle);
      }
      const value = sinc * window;
      kernel[tap] = value;
      sum += value;
    }
    if (sum !== 0) {
      for (let tap = 0; tap < KERNEL_TAPS; tap += 1) kernel[tap] = kernel[tap]! / sum;
    }
    kernels.push(kernel);
  }
  return kernels;
}
