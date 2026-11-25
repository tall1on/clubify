export interface BiquadCoefficients {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

const IDENTITY: BiquadCoefficients = { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 };

export class Biquad {
  private coefficients: BiquadCoefficients = IDENTITY;
  private z1 = 0;
  private z2 = 0;

  setCoefficients(coefficients: BiquadCoefficients): void {
    this.coefficients = coefficients;
  }

  process(input: number): number {
    const { b0, b1, b2, a1, a2 } = this.coefficients;
    const output = b0 * input + this.z1;
    this.z1 = b1 * input - a1 * output + this.z2;
    this.z2 = b2 * input - a2 * output;
    return output;
  }

  reset(): void {
    this.z1 = 0;
    this.z2 = 0;
  }
}

export class StereoBiquad {
  private readonly left = new Biquad();
  private readonly right = new Biquad();

  setCoefficients(coefficients: BiquadCoefficients): void {
    this.left.setCoefficients(coefficients);
    this.right.setCoefficients(coefficients);
  }

  process(left: number, right: number): [number, number] {
    return [this.left.process(left), this.right.process(right)];
  }

  processBlock(
    left: Float32Array,
    right: Float32Array,
    offset: number,
    length: number,
  ): void {
    for (let index = offset; index < offset + length; index += 1) {
      left[index] = this.left.process(left[index]!);
      right[index] = this.right.process(right[index]!);
    }
  }

  reset(): void {
    this.left.reset();
    this.right.reset();
  }
}

export function normalize(
  b0: number,
  b1: number,
  b2: number,
  a0: number,
  a1: number,
  a2: number,
): BiquadCoefficients {
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

export function lowShelf(
  sampleRate: number,
  frequency: number,
  gainDb: number,
): BiquadCoefficients {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * frequency) / sampleRate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = (sin / 2) * Math.SQRT2;
  const beta = 2 * Math.sqrt(A) * alpha;
  const b0 = A * (A + 1 - (A - 1) * cos + beta);
  const b1 = 2 * A * (A - 1 - (A + 1) * cos);
  const b2 = A * (A + 1 - (A - 1) * cos - beta);
  const a0 = A + 1 + (A - 1) * cos + beta;
  const a1 = -2 * (A - 1 + (A + 1) * cos);
  const a2 = A + 1 + (A - 1) * cos - beta;
  return normalize(b0, b1, b2, a0, a1, a2);
}

export function highShelf(
  sampleRate: number,
  frequency: number,
  gainDb: number,
): BiquadCoefficients {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * frequency) / sampleRate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = (sin / 2) * Math.SQRT2;
  const beta = 2 * Math.sqrt(A) * alpha;
  const b0 = A * (A + 1 + (A - 1) * cos + beta);
  const b1 = -2 * A * (A - 1 + (A + 1) * cos);
  const b2 = A * (A + 1 + (A - 1) * cos - beta);
  const a0 = A + 1 - (A - 1) * cos + beta;
  const a1 = 2 * (A - 1 - (A + 1) * cos);
  const a2 = A + 1 - (A - 1) * cos - beta;
  return normalize(b0, b1, b2, a0, a1, a2);
}

export function peaking(
  sampleRate: number,
  frequency: number,
  gainDb: number,
  q: number,
): BiquadCoefficients {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * frequency) / sampleRate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = sin / (2 * q);
  const b0 = 1 + alpha * A;
  const b1 = -2 * cos;
  const b2 = 1 - alpha * A;
  const a0 = 1 + alpha / A;
  const a1 = -2 * cos;
  const a2 = 1 - alpha / A;
  return normalize(b0, b1, b2, a0, a1, a2);
}

export function highPass(
  sampleRate: number,
  frequency: number,
  q = Math.SQRT1_2,
): BiquadCoefficients {
  const w0 = (2 * Math.PI * frequency) / sampleRate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = sin / (2 * q);
  const b0 = (1 + cos) / 2;
  const b1 = -(1 + cos);
  const b2 = (1 + cos) / 2;
  const a0 = 1 + alpha;
  const a1 = -2 * cos;
  const a2 = 1 - alpha;
  return normalize(b0, b1, b2, a0, a1, a2);
}

export function lowPass(
  sampleRate: number,
  frequency: number,
  q = Math.SQRT1_2,
): BiquadCoefficients {
  const w0 = (2 * Math.PI * frequency) / sampleRate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = sin / (2 * q);
  const b0 = (1 - cos) / 2;
  const b1 = 1 - cos;
  const b2 = (1 - cos) / 2;
  const a0 = 1 + alpha;
  const a1 = -2 * cos;
  const a2 = 1 - alpha;
  return normalize(b0, b1, b2, a0, a1, a2);
}
