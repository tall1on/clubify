import { Biquad, highPass, lowPass } from "./biquad.js";

const CROSSOVER_HZ = 130;
const DRIVE_RANGE = 4;
const MAKEUP_RANGE = 0.5;
const SMALL_DELTA = 1e-5;

export class Saturation {
  private amount = 0;
  private drive = 1;
  private makeup = 1;
  private readonly lowLeft = new Biquad();
  private readonly lowRight = new Biquad();
  private readonly lowLeft2 = new Biquad();
  private readonly lowRight2 = new Biquad();
  private readonly highLeft = new Biquad();
  private readonly highRight = new Biquad();
  private readonly highLeft2 = new Biquad();
  private readonly highRight2 = new Biquad();
  private previousLowLeft = 0;
  private previousLowRight = 0;

  constructor(sampleRate = 48_000) {
    const low = lowPass(sampleRate, CROSSOVER_HZ, Math.SQRT1_2);
    const high = highPass(sampleRate, CROSSOVER_HZ, Math.SQRT1_2);
    this.lowLeft.setCoefficients(low);
    this.lowRight.setCoefficients(low);
    this.lowLeft2.setCoefficients(low);
    this.lowRight2.setCoefficients(low);
    this.highLeft.setCoefficients(high);
    this.highRight.setCoefficients(high);
    this.highLeft2.setCoefficients(high);
    this.highRight2.setCoefficients(high);
  }

  setAmount(amount: number): void {
    this.amount = Math.min(1, Math.max(0, amount));
    this.drive = 1 + this.amount * DRIVE_RANGE;
    this.makeup = 1 + this.amount * MAKEUP_RANGE;
  }

  reset(): void {
    this.lowLeft.reset();
    this.lowRight.reset();
    this.lowLeft2.reset();
    this.lowRight2.reset();
    this.highLeft.reset();
    this.highRight.reset();
    this.highLeft2.reset();
    this.highRight2.reset();
    this.previousLowLeft = 0;
    this.previousLowRight = 0;
  }

  processBlock(
    left: Float32Array,
    right: Float32Array,
    offset: number,
    length: number,
  ): void {
    if (this.amount <= 0.0001) return;
    const inverseDrive = 1 / this.drive;
    const wet = this.amount * 0.85;
    const dry = 1 - wet;
    for (let index = offset; index < offset + length; index += 1) {
      const leftSample = left[index]!;
      const rightSample = right[index]!;
      const lowLeft = this.lowLeft2.process(this.lowLeft.process(leftSample));
      const lowRight = this.lowRight2.process(this.lowRight.process(rightSample));
      const highLeft = this.highLeft2.process(this.highLeft.process(leftSample));
      const highRight = this.highRight2.process(this.highRight.process(rightSample));

      const drivenLeft = lowLeft * this.drive;
      const drivenRight = lowRight * this.drive;
      const shapedLeft = antiderivativeTanh(drivenLeft, this.previousLowLeft);
      const shapedRight = antiderivativeTanh(drivenRight, this.previousLowRight);
      this.previousLowLeft = drivenLeft;
      this.previousLowRight = drivenRight;

      const saturatedLeft = shapedLeft * inverseDrive * this.makeup;
      const saturatedRight = shapedRight * inverseDrive * this.makeup;
      left[index] = highLeft + lowLeft * dry + saturatedLeft * wet;
      right[index] = highRight + lowRight * dry + saturatedRight * wet;
    }
  }
}

function antiderivativeTanh(current: number, previous: number): number {
  const delta = current - previous;
  if (Math.abs(delta) < SMALL_DELTA) {
    return Math.tanh((current + previous) * 0.5);
  }
  return (logCosh(current) - logCosh(previous)) / delta;
}

function logCosh(value: number): number {
  const magnitude = Math.abs(value);
  return magnitude + Math.log1p(Math.exp(-2 * magnitude)) - Math.LN2;
}
