const COMB_TUNINGS = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const ALLPASS_TUNINGS = [556, 441, 341, 225];
const STEREO_SPREAD = 23;
const FIXED_GAIN = 0.015;
const PREDELAY_SECONDS = 0.012;

class Comb {
  private readonly buffer: Float32Array;
  private index = 0;
  private filterStore = 0;
  private feedback: number;
  private damp1: number;
  private damp2: number;

  constructor(length: number, feedback: number, damping: number) {
    this.buffer = new Float32Array(Math.max(1, length));
    this.feedback = feedback;
    this.damp1 = damping;
    this.damp2 = 1 - damping;
  }

  configure(feedback: number, damping: number): void {
    this.feedback = feedback;
    this.damp1 = damping;
    this.damp2 = 1 - damping;
  }

  process(input: number): number {
    const output = this.buffer[this.index]!;
    this.filterStore = output * this.damp2 + this.filterStore * this.damp1;
    this.buffer[this.index] = input + this.filterStore * this.feedback;
    this.index += 1;
    if (this.index >= this.buffer.length) this.index = 0;
    return output;
  }

  reset(): void {
    this.buffer.fill(0);
    this.filterStore = 0;
    this.index = 0;
  }
}

class Allpass {
  private readonly buffer: Float32Array;
  private index = 0;
  private readonly feedback = 0.5;

  constructor(length: number) {
    this.buffer = new Float32Array(Math.max(1, length));
  }

  process(input: number): number {
    const stored = this.buffer[this.index]!;
    const output = -input + stored;
    this.buffer[this.index] = input + stored * this.feedback;
    this.index += 1;
    if (this.index >= this.buffer.length) this.index = 0;
    return output;
  }

  reset(): void {
    this.buffer.fill(0);
    this.index = 0;
  }
}

export interface ReverbSettings {
  size: number;
  damping: number;
  sampleRate: number;
}

export class Reverb {
  private combsLeft: Comb[] = [];
  private combsRight: Comb[] = [];
  private allpassesLeft: Allpass[] = [];
  private allpassesRight: Allpass[] = [];
  private predelay: Float32Array;
  private predelayIndex = 0;
  private sampleRate = 0;
  private size = 0.6;
  private damping = 0.45;

  constructor(sampleRate: number) {
    this.predelay = new Float32Array(1);
    this.configure({ size: this.size, damping: this.damping, sampleRate });
  }

  private build(sampleRate: number): void {
    const scale = sampleRate / 44_100;
    this.combsLeft = COMB_TUNINGS.map(
      (length) => new Comb(Math.round(length * scale), 0.84, 0.2),
    );
    this.combsRight = COMB_TUNINGS.map(
      (length) => new Comb(Math.round((length + STEREO_SPREAD) * scale), 0.84, 0.2),
    );
    this.allpassesLeft = ALLPASS_TUNINGS.map(
      (length) => new Allpass(Math.round(length * scale)),
    );
    this.allpassesRight = ALLPASS_TUNINGS.map(
      (length) => new Allpass(Math.round((length + STEREO_SPREAD) * scale)),
    );
    this.predelay = new Float32Array(Math.max(1, Math.round(PREDELAY_SECONDS * sampleRate)));
    this.predelayIndex = 0;
    this.sampleRate = sampleRate;
  }

  configure(settings: ReverbSettings): void {
    if (settings.sampleRate !== this.sampleRate) this.build(settings.sampleRate);
    this.size = Math.min(0.95, Math.max(0.2, settings.size));
    this.damping = Math.min(1, Math.max(0, settings.damping));
    const feedback = 0.7 + this.size * 0.28;
    const filterDamping = 0.05 + this.damping * 0.85;
    for (const comb of this.combsLeft) comb.configure(feedback, filterDamping);
    for (const comb of this.combsRight) comb.configure(feedback, filterDamping);
  }

  reset(): void {
    for (const comb of this.combsLeft) comb.reset();
    for (const comb of this.combsRight) comb.reset();
    for (const allpass of this.allpassesLeft) allpass.reset();
    for (const allpass of this.allpassesRight) allpass.reset();
    this.predelay.fill(0);
    this.predelayIndex = 0;
  }

  processBlock(
    left: Float32Array,
    right: Float32Array,
    offset: number,
    length: number,
    wet: number,
  ): void {
    if (wet <= 0.0001) return;
    for (let index = offset; index < offset + length; index += 1) {
      const input = (left[index]! + right[index]!) * 0.5 * FIXED_GAIN;
      const delayed = this.predelay[this.predelayIndex]!;
      this.predelay[this.predelayIndex] = input;
      this.predelayIndex += 1;
      if (this.predelayIndex >= this.predelay.length) this.predelayIndex = 0;

      let wetLeft = 0;
      let wetRight = 0;
      for (let combIndex = 0; combIndex < this.combsLeft.length; combIndex += 1) {
        wetLeft += this.combsLeft[combIndex]!.process(delayed);
        wetRight += this.combsRight[combIndex]!.process(delayed);
      }
      for (let allpassIndex = 0; allpassIndex < this.allpassesLeft.length; allpassIndex += 1) {
        wetLeft = this.allpassesLeft[allpassIndex]!.process(wetLeft);
        wetRight = this.allpassesRight[allpassIndex]!.process(wetRight);
      }

      left[index] = left[index]! + wetLeft * wet;
      right[index] = right[index]! + wetRight * wet;
    }
  }
}
