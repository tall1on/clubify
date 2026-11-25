const ATTACK_SECONDS = 0.02;
const RELEASE_SECONDS = 0.15;
const DETECTOR_SECONDS = 0.008;
const KNEE_DB = 6;
const MAX_MAKEUP_DB = 3;
const EPSILON = 1e-9;

export interface CompressorSettings {
  amount: number;
  thresholdDb: number;
  ratio: number;
  sampleRate: number;
}

export class Compressor {
  private amount = 0;
  private thresholdDb = -20;
  private ratio = 3;
  private attackCoefficient = 0;
  private releaseCoefficient = 0;
  private detectorCoefficient = 0;
  private detector = 0;
  private smoothedGain = 1;
  private makeupGain = 1;

  constructor(sampleRate: number) {
    this.setSampleRate(sampleRate);
  }

  private setSampleRate(sampleRate: number): void {
    this.attackCoefficient = 1 - Math.exp(-1 / (ATTACK_SECONDS * sampleRate));
    this.releaseCoefficient = 1 - Math.exp(-1 / (RELEASE_SECONDS * sampleRate));
    this.detectorCoefficient = 1 - Math.exp(-1 / (DETECTOR_SECONDS * sampleRate));
  }

  configure(settings: CompressorSettings): void {
    this.amount = Math.min(1, Math.max(0, settings.amount));
    this.thresholdDb = settings.thresholdDb;
    this.ratio = 1 + (Math.max(1, settings.ratio) - 1) * this.amount;
    const reductionDb = Math.max(0, -settings.thresholdDb) * (1 - 1 / this.ratio);
    this.makeupGain = Math.pow(10, Math.min(MAX_MAKEUP_DB, reductionDb * 0.4) / 20);
  }

  reset(): void {
    this.smoothedGain = 1;
    this.detector = 0;
  }

  processBlock(
    left: Float32Array,
    right: Float32Array,
    offset: number,
    length: number,
  ): void {
    if (this.amount <= 0.0001 || this.ratio <= 1.0001) return;
    const knee = KNEE_DB;
    const slope = 1 - 1 / this.ratio;
    const detectorCoefficient = this.detectorCoefficient;
    for (let index = offset; index < offset + length; index += 1) {
      const leftSample = left[index]!;
      const rightSample = right[index]!;
      const power = (leftSample * leftSample + rightSample * rightSample) * 0.5;
      this.detector += (power - this.detector) * detectorCoefficient;
      const levelDb = 20 * Math.log10(Math.sqrt(Math.max(0, this.detector)) + EPSILON);
      let reductionDb = 0;
      if (levelDb > this.thresholdDb + knee / 2) {
        reductionDb = (levelDb - this.thresholdDb) * slope;
      } else if (levelDb > this.thresholdDb - knee / 2) {
        const kneeInput = levelDb - this.thresholdDb + knee / 2;
        reductionDb = (slope * kneeInput * kneeInput) / (2 * knee);
      }
      const targetGain = Math.pow(10, -reductionDb / 20);
      const coefficient =
        targetGain < this.smoothedGain
          ? this.attackCoefficient
          : this.releaseCoefficient;
      this.smoothedGain += (targetGain - this.smoothedGain) * coefficient;
      const gain = this.smoothedGain * this.makeupGain;
      left[index] = leftSample * gain;
      right[index] = rightSample * gain;
    }
  }
}
