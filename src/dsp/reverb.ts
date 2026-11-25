const LINE_TIMES_MS = [29.7, 37.1, 41.1, 43.7, 47.3, 53.9, 59.1, 61.7];
const DIFFUSION_TIMES_MS = [4.77, 3.59, 2.79, 1.93];
const DIFFUSION_GAIN = 0.62;
const INPUT_GAIN = 0.16;
const MAX_PREDELAY_MS = 60;
const MAX_DAMPING = 0.85;
const MAX_SIZE_SCALE = 1.3;
const MODULATION_DEPTH_MS = 0.35;

export interface ReverbSettings {
  size: number;
  damping: number;
  sampleRate: number;
  predelayMs?: number;
}

class DelayLine {
  private readonly buffer: Float32Array;
  private index = 0;
  private dampState = 0;
  private feedback = 0.8;
  private dampCoefficient = 0.6;
  private baseDelay: number;
  private readonly depth: number;
  private phase = 0;
  private readonly phaseIncrement: number;

  constructor(maxDelay: number, sampleRate: number, lfoHz: number) {
    this.depth = Math.max(1, Math.round((MODULATION_DEPTH_MS / 1_000) * sampleRate));
    this.buffer = new Float32Array(maxDelay + this.depth + 2);
    this.baseDelay = maxDelay;
    this.phaseIncrement = (2 * Math.PI * lfoHz) / sampleRate;
  }

  configure(feedback: number, dampCoefficient: number, delay: number): void {
    this.feedback = feedback;
    this.dampCoefficient = dampCoefficient;
    const maxDelay = this.buffer.length - this.depth - 2;
    this.baseDelay = Math.min(maxDelay, Math.max(1, delay));
  }

  read(): number {
    this.phase += this.phaseIncrement;
    if (this.phase >= 2 * Math.PI) this.phase -= 2 * Math.PI;
    const modulation = (Math.sin(this.phase) * 0.5 + 0.5) * this.depth;
    const size = this.buffer.length;
    let position = this.index - this.baseDelay - modulation;
    if (position < 0) position += size;
    const first = Math.floor(position);
    const second = (first + 1) % size;
    const fraction = position - first;
    const a = this.buffer[first]!;
    const b = this.buffer[second]!;
    return a + (b - a) * fraction;
  }

  write(input: number, feedbackMix: number): void {
    this.buffer[this.index] = input + feedbackMix * this.feedback;
    this.index += 1;
    if (this.index >= this.buffer.length) this.index = 0;
  }

  damp(sample: number): number {
    this.dampState += (sample - this.dampState) * this.dampCoefficient;
    return this.dampState;
  }

  reset(): void {
    this.buffer.fill(0);
    this.dampState = 0;
    this.index = 0;
    this.phase = 0;
  }
}

class Allpass {
  private readonly buffer: Float32Array;
  private index = 0;

  constructor(length: number) {
    this.buffer = new Float32Array(Math.max(1, length));
  }

  process(input: number): number {
    const stored = this.buffer[this.index]!;
    const output = -input + stored;
    this.buffer[this.index] = input + stored * DIFFUSION_GAIN;
    this.index += 1;
    if (this.index >= this.buffer.length) this.index = 0;
    return output;
  }

  reset(): void {
    this.buffer.fill(0);
    this.index = 0;
  }
}

export class Reverb {
  private lines: DelayLine[] = [];
  private diffusion: Allpass[] = [];
  private predelay: Float32Array;
  private predelayIndex = 0;
  private predelaySamples = 0;
  private sampleRate = 0;
  private size = 0.6;
  private damping = 0.45;
  private readonly lineVector = new Float64Array(LINE_TIMES_MS.length);

  constructor(sampleRate: number) {
    this.predelay = new Float32Array(1);
    this.configure({ size: this.size, damping: this.damping, sampleRate });
  }

  private build(sampleRate: number): void {
    this.lines = LINE_TIMES_MS.map((ms, line) => {
      const maxDelay = Math.round((ms / 1_000) * sampleRate * MAX_SIZE_SCALE) + 1;
      return new DelayLine(maxDelay, sampleRate, 0.13 + line * 0.021);
    });
    this.diffusion = DIFFUSION_TIMES_MS.map(
      (ms) => new Allpass(Math.max(1, Math.round((ms / 1_000) * sampleRate))),
    );
    this.predelay = new Float32Array(Math.max(1, Math.round((MAX_PREDELAY_MS / 1_000) * sampleRate)));
    this.predelaySamples = Math.min(
      this.predelay.length - 1,
      Math.round((20 / 1_000) * sampleRate),
    );
    this.predelayIndex = 0;
    this.sampleRate = sampleRate;
  }

  configure(settings: ReverbSettings): void {
    if (settings.sampleRate !== this.sampleRate) this.build(settings.sampleRate);
    this.size = Math.min(0.95, Math.max(0.2, settings.size));
    this.damping = Math.min(1, Math.max(0, settings.damping));
    this.predelaySamples = Math.min(
      this.predelay.length - 1,
      Math.max(0, Math.round(((settings.predelayMs ?? 20) / 1_000) * this.sampleRate)),
    );

    const scale = 0.7 + this.size * 0.6;
    const rt60 = 0.4 + this.size * 1.8;
    const dampCoefficient = 1 - (0.05 + this.damping * MAX_DAMPING);
    for (let line = 0; line < this.lines.length; line += 1) {
      const delaySeconds = (LINE_TIMES_MS[line]! * scale) / 1_000;
      const feedback = Math.pow(10, (-3 * delaySeconds) / rt60);
      this.lines[line]!.configure(
        feedback,
        dampCoefficient,
        Math.round(delaySeconds * this.sampleRate),
      );
    }
  }

  reset(): void {
    for (const line of this.lines) line.reset();
    for (const allpass of this.diffusion) allpass.reset();
    this.predelay.fill(0);
    this.predelayIndex = 0;
  }

  get sampleRateHz(): number {
    return this.sampleRate;
  }

  process(
    sendLeft: Float32Array,
    sendRight: Float32Array,
    wetLeft: Float32Array,
    wetRight: Float32Array,
    offset: number,
    length: number,
  ): void {
    const lines = this.lines;
    const diffusion = this.diffusion;
    const vector = this.lineVector;
    const predelay = this.predelay;
    const predelaySize = predelay.length;
    const normalization = 1 / Math.sqrt(lines.length);

    for (let index = offset; index < offset + length; index += 1) {
      const input = (sendLeft[index]! + sendRight[index]!) * 0.5 * INPUT_GAIN;
      predelay[this.predelayIndex] = input;
      const readIndex = (this.predelayIndex - this.predelaySamples + predelaySize) % predelaySize;
      let diffused = predelay[readIndex]!;
      this.predelayIndex += 1;
      if (this.predelayIndex >= predelaySize) this.predelayIndex = 0;

      for (const allpass of diffusion) diffused = allpass.process(diffused);

      let left = 0;
      let right = 0;
      for (let line = 0; line < lines.length; line += 1) {
        const output = lines[line]!.read();
        vector[line] = lines[line]!.damp(output);
        if ((line & 1) === 0) {
          left += output;
        } else {
          right += output;
        }
      }

      hadamard(vector);

      for (let line = 0; line < lines.length; line += 1) {
        lines[line]!.write(diffused, vector[line]! * normalization);
      }

      wetLeft[index] = wetLeft[index]! + left * 0.5;
      wetRight[index] = wetRight[index]! + right * 0.5;
    }
  }

  processBlock(
    left: Float32Array,
    right: Float32Array,
    offset: number,
    length: number,
    wet: number,
  ): void {
    if (wet <= 0.0001) return;
    const size = Math.min(length, left.length, right.length);
    const wetLeft = new Float32Array(size);
    const wetRight = new Float32Array(size);
    this.process(left, right, wetLeft, wetRight, offset, size);
    for (let index = 0; index < size; index += 1) {
      left[offset + index] = left[offset + index]! + wetLeft[index]! * wet;
      right[offset + index] = right[offset + index]! + wetRight[index]! * wet;
    }
  }
}

function hadamard(vector: Float64Array): void {
  const length = vector.length;
  for (let stride = 1; stride < length; stride *= 2) {
    for (let start = 0; start < length; start += stride * 2) {
      for (let index = start; index < start + stride; index += 1) {
        const a = vector[index]!;
        const b = vector[index + stride]!;
        vector[index] = a + b;
        vector[index + stride] = a - b;
      }
    }
  }
}
