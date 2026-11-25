import { highPass, lowShelf, StereoBiquad } from "./biquad.js";
import { Compressor } from "./compressor.js";
import { Limiter } from "./limiter.js";
import { Reverb } from "./reverb.js";
import { Saturation } from "./saturation.js";
import type { DspParams } from "../shared/types.js";

const SMOOTHING = 0.18;

export class DspChain {
  private readonly sampleRate: number;
  private readonly highPassFilter = new StereoBiquad();
  private readonly bassShelf = new StereoBiquad();
  private readonly saturation = new Saturation();
  private readonly compressor: Compressor;
  private readonly reverb: Reverb;
  private readonly limiter: Limiter;
  private readonly dryLeft: Float32Array;
  private readonly dryRight: Float32Array;
  private params: DspParams;

  private smoothInputGain = 1;
  private smoothBassDb = 0;
  private smoothBassFrequency = 90;
  private smoothSaturation = 0;
  private smoothReverbMix = 0;
  private smoothReverbSize = 0.6;
  private smoothReverbDamping = 0.45;
  private smoothOutputGain = 1;
  private smoothWet = 1;

  constructor(sampleRate: number, initialParams: DspParams, maxBlockFrames: number) {
    this.sampleRate = sampleRate;
    this.params = initialParams;
    this.compressor = new Compressor(sampleRate);
    this.reverb = new Reverb(sampleRate);
    this.limiter = new Limiter(sampleRate);
    this.dryLeft = new Float32Array(maxBlockFrames);
    this.dryRight = new Float32Array(maxBlockFrames);
    this.highPassFilter.setCoefficients(highPass(sampleRate, 26));
    this.saturation.setAmount(initialParams.saturation);
    this.reverb.configure({
      size: initialParams.reverbSize,
      damping: initialParams.reverbDamping,
      sampleRate,
    });
    this.compressor.configure({
      amount: initialParams.compression,
      thresholdDb: initialParams.thresholdDb,
      ratio: initialParams.ratio,
      sampleRate,
    });
    this.updateSmoothedValues(1);
    this.applyBlockParameters();
  }

  setParams(params: DspParams): void {
    this.params = params;
  }

  reset(): void {
    this.highPassFilter.reset();
    this.bassShelf.reset();
    this.compressor.reset();
    this.reverb.reset();
    this.limiter.reset();
  }

  processBlock(left: Float32Array, right: Float32Array, length: number): void {
    if (length <= 0) return;
    const frames = Math.min(length, this.dryLeft.length);
    for (let index = 0; index < frames; index += 1) {
      this.dryLeft[index] = left[index]!;
      this.dryRight[index] = right[index]!;
    }

    this.updateSmoothedValues(SMOOTHING);
    this.applyBlockParameters();

    const inputGain = this.smoothInputGain;
    for (let index = 0; index < frames; index += 1) {
      left[index] = left[index]! * inputGain;
      right[index] = right[index]! * inputGain;
    }

    this.highPassFilter.processBlock(left, right, 0, frames);
    this.bassShelf.processBlock(left, right, 0, frames);
    this.saturation.processBlock(left, right, 0, frames);
    this.compressor.processBlock(left, right, 0, frames);
    this.reverb.processBlock(left, right, 0, frames, this.smoothReverbMix);
    for (let index = 0; index < frames; index += 1) {
      left[index] = left[index]! * this.smoothOutputGain;
      right[index] = right[index]! * this.smoothOutputGain;
    }
    this.limiter.processBlock(left, right, 0, frames);

    const wet = this.smoothWet;
    const dry = 1 - wet;
    for (let index = 0; index < frames; index += 1) {
      left[index] = this.dryLeft[index]! * dry + left[index]! * wet;
      right[index] = this.dryRight[index]! * dry + right[index]! * wet;
    }
  }

  private updateSmoothedValues(coefficient: number): void {
    const params = this.params;
    this.smoothInputGain = smooth(this.smoothInputGain, dbToGain(params.inputGainDb), coefficient);
    this.smoothBassDb = smooth(this.smoothBassDb, params.bassDb, coefficient);
    this.smoothBassFrequency = smooth(
      this.smoothBassFrequency,
      params.bassFrequency,
      coefficient,
    );
    this.smoothSaturation = smooth(this.smoothSaturation, params.saturation, coefficient);
    this.smoothReverbMix = smooth(this.smoothReverbMix, params.reverbMix, coefficient);
    this.smoothReverbSize = smooth(this.smoothReverbSize, params.reverbSize, coefficient);
    this.smoothReverbDamping = smooth(
      this.smoothReverbDamping,
      params.reverbDamping,
      coefficient,
    );
    this.smoothOutputGain = smooth(this.smoothOutputGain, dbToGain(params.outputGainDb), coefficient);
    this.smoothWet = smooth(this.smoothWet, params.effectsEnabled ? 1 : 0, coefficient);
  }

  private applyBlockParameters(): void {
    this.bassShelf.setCoefficients(
      lowShelf(this.sampleRate, this.smoothBassFrequency, this.smoothBassDb),
    );
    this.saturation.setAmount(this.smoothSaturation);
    this.compressor.configure({
      amount: this.params.compression,
      thresholdDb: this.params.thresholdDb,
      ratio: this.params.ratio,
      sampleRate: this.sampleRate,
    });
    this.reverb.configure({
      size: this.smoothReverbSize,
      damping: this.smoothReverbDamping,
      sampleRate: this.sampleRate,
    });
  }
}

function smooth(current: number, target: number, coefficient: number): number {
  return current + (target - current) * coefficient;
}

export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}
