const ATTACK_SECONDS = 0.0015;
const RELEASE_SECONDS = 0.12;
const SOFT_KNEE = 0.95;

export class Limiter {
  private gain = 1;
  private readonly attackCoefficient: number;
  private readonly releaseCoefficient: number;

  constructor(sampleRate: number) {
    this.attackCoefficient = 1 - Math.exp(-1 / (ATTACK_SECONDS * sampleRate));
    this.releaseCoefficient = 1 - Math.exp(-1 / (RELEASE_SECONDS * sampleRate));
  }

  reset(): void {
    this.gain = 1;
  }

  processBlock(
    left: Float32Array,
    right: Float32Array,
    offset: number,
    length: number,
  ): void {
    for (let index = offset; index < offset + length; index += 1) {
      const leftSample = left[index]!;
      const rightSample = right[index]!;
      const magnitude = Math.max(Math.abs(leftSample), Math.abs(rightSample));
      if (magnitude > 0.000001) {
        const targetGain = magnitude > 1 ? 1 / magnitude : 1;
        const coefficient =
          targetGain < this.gain ? this.attackCoefficient : this.releaseCoefficient;
        this.gain += (targetGain - this.gain) * coefficient;
      } else {
        this.gain += (1 - this.gain) * this.releaseCoefficient;
      }
      left[index] = softClip(leftSample * this.gain);
      right[index] = softClip(rightSample * this.gain);
    }
  }
}

function softClip(sample: number): number {
  const magnitude = Math.abs(sample);
  if (magnitude <= SOFT_KNEE) return sample;
  const excess = (magnitude - SOFT_KNEE) / (1 - SOFT_KNEE);
  const limited = SOFT_KNEE + (1 - SOFT_KNEE) * Math.tanh(excess);
  return Math.sign(sample) * Math.min(1, limited);
}
