const DEFAULT_CAPACITY_FRAMES = 192_000;
const CHANNELS = 2;
const KERNEL_TAPS = 48;
const KERNEL_PHASES = 512;
const KERNEL_OFFSET = KERNEL_TAPS / 2 - 1;
const KERNEL_HALF_WIDTH = KERNEL_TAPS / 2;
const KERNEL_CUTOFF = 0.95;
const KAISER_BETA = 8.6;

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
  private pushedFrames = 0;
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
    let writeFrame = (this.startFrame + this.availableFrames) % this.capacityFrames;
    let source = 0;
    let remaining = frames;
    while (remaining > 0) {
      const count = Math.min(remaining, this.capacityFrames - writeFrame);
      this.buffer.set(
        samples.subarray(source, source + count * CHANNELS),
        writeFrame * CHANNELS,
      );
      source += count * CHANNELS;
      remaining -= count;
      writeFrame = 0;
    }
    this.availableFrames += frames;
    this.pushedFrames += frames;
  }

  pushInterleaved(left: Float32Array, right: Float32Array, frames: number): void {    if (frames <= 0) return;
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
    this.pushedFrames += frames;
  }

  read(frames: number, ratio = 1): QueueRead {
    const data = new Float32Array(frames * CHANNELS);
    const missingFrames = this.readInto(data, frames, ratio);
    return { data, missingFrames };
  }

  /**
   * Reads `frames` frames into `out`. Returns `frames` without consuming audio
   * when the queue cannot cover the resampler margin.
   */
  readInto(out: Float32Array, frames: number, ratio = 1): number {
    if (frames <= 0) return 0;
    if (ratio !== 1) this.settling = false;
    const effectiveRatio = this.settling && ratio === 1 ? 0.9995 : ratio;
    if (effectiveRatio === 1 && this.fraction === 0) {
      if (frames > this.availableFrames) {
        out.fill(0, 0, frames * CHANNELS);
        return frames;
      }
      this.copyFrames(out, frames);
      return 0;
    }

    const required =
      Math.ceil((frames - 1) * effectiveRatio) + KERNEL_HALF_WIDTH + 2;
    if (required > this.availableFrames) {
      out.fill(0, 0, frames * CHANNELS);
      return frames;
    }

    for (let frame = 0; frame < frames; frame += 1) {
      const base = Math.floor(this.fraction);
      const position = (this.fraction - base) * KERNEL_PHASES;
      const phase = Math.min(KERNEL_PHASES - 1, Math.floor(position));
      const blend = position - phase;
      const first = KERNELS[phase]!;
      const second = KERNELS[phase + 1]!;
      const frameCount = this.availableFrames;
      let sumLeft = 0;
      let sumRight = 0;
      for (let tap = 0; tap < KERNEL_TAPS; tap += 1) {
        const weight = first[tap]! + (second[tap]! - first[tap]!) * blend;
        const ringIndex = this.ringIndex(base - KERNEL_OFFSET + tap, frameCount);
        const source = ringIndex * CHANNELS;
        sumLeft += this.buffer[source]! * weight;
        sumRight += this.buffer[source + 1]! * weight;
      }
      out[frame * CHANNELS] = sumLeft;
      out[frame * CHANNELS + 1] = sumRight;
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
    return 0;
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
    this.pushedFrames = 0;
    this.fraction = 0;
    this.settling = false;
  }

  private copyFrames(out: Float32Array, frames: number): void {
    let sourceFrame = this.startFrame;
    let written = 0;
    let remaining = frames;
    while (remaining > 0) {
      const count = Math.min(remaining, this.capacityFrames - sourceFrame);
      out.set(
        this.buffer.subarray(
          sourceFrame * CHANNELS,
          (sourceFrame + count) * CHANNELS,
        ),
        written * CHANNELS,
      );
      written += count;
      remaining -= count;
      sourceFrame = 0;
    }
    this.startFrame = (this.startFrame + frames) % this.capacityFrames;
    this.availableFrames -= frames;
  }

  private ringIndex(offset: number, frameCount: number): number {
    let index = offset;
    if (index >= frameCount) index = frameCount - 1;
    let ringIndex = this.startFrame + index;
    if (ringIndex < 0) {
      // Before the ring has wrapped there is no history behind the read cursor;
      // clamp to the first queued frame instead of reading unwritten slots.
      if (this.pushedFrames < this.capacityFrames) return this.startFrame;
      ringIndex += this.capacityFrames;
    } else if (ringIndex >= this.capacityFrames) {
      ringIndex -= this.capacityFrames;
    }
    return ringIndex;
  }

  private ensureCapacity(frames: number): void {
    if (frames <= this.capacityFrames) return;
    let capacity = this.capacityFrames;
    while (capacity < frames) capacity *= 2;
    const next = new Float32Array(capacity * CHANNELS);
    let sourceFrame = this.startFrame;
    let written = 0;
    let remaining = this.availableFrames;
    while (remaining > 0) {
      const count = Math.min(remaining, this.capacityFrames - sourceFrame);
      next.set(
        this.buffer.subarray(
          sourceFrame * CHANNELS,
          (sourceFrame + count) * CHANNELS,
        ),
        written * CHANNELS,
      );
      written += count;
      remaining -= count;
      sourceFrame = 0;
    }
    this.buffer = next;
    this.capacityFrames = capacity;
    this.startFrame = 0;
  }
}

/**
 * Polyphase Kaiser-windowed sinc, matching the native tap resampler so drift
 * correction no longer dulls the high end when it engages.
 */
function buildKernels(): Float32Array[] {
  const kernels: Float32Array[] = [];
  const i0Beta = besselI0(KAISER_BETA);
  const cutoff = 0.5 * KERNEL_CUTOFF;
  for (let phase = 0; phase <= KERNEL_PHASES; phase += 1) {
    const fraction = phase / KERNEL_PHASES;
    const kernel = new Float32Array(KERNEL_TAPS);
    let sum = 0;
    for (let tap = 0; tap < KERNEL_TAPS; tap += 1) {
      const distance = KERNEL_OFFSET - tap + fraction;
      const normalized = distance / KERNEL_HALF_WIDTH;
      let window = 0;
      if (Math.abs(normalized) < 1) {
        window =
          besselI0(KAISER_BETA * Math.sqrt(1 - normalized * normalized)) / i0Beta;
      }
      const angle = 2 * Math.PI * cutoff * distance;
      const sinc = Math.abs(angle) < 1e-9 ? 1 : Math.sin(angle) / angle;
      const value = 2 * cutoff * sinc * window;
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

function besselI0(value: number): number {
  let sum = 1;
  let term = 1;
  const half = value / 2;
  for (let index = 1; index < 64; index += 1) {
    const ratio = half / index;
    term *= ratio * ratio;
    sum += term;
    if (term < 1e-12 * sum) break;
  }
  return sum;
}
