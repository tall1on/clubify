import { highPass, lowPass, lowShelf, peaking, StereoBiquad } from "./biquad.js";
import { Compressor } from "./compressor.js";
import { EarlyReflections } from "./early-reflections.js";
import { Limiter } from "./limiter.js";
import { Reverb } from "./reverb.js";
import { Saturation } from "./saturation.js";
import type { DspParams } from "../shared/types.js";

const SMOOTHING = 0.18;
const HEADROOM_TRIM = 0.5;
const HEADROOM_MAKEUP = 2;
const DUCK_LOWPASS_HZ = 150;
const DUCK_ATTACK_SECONDS = 0.004;
const DUCK_RELEASE_SECONDS = 0.12;
const DUCK_DEPTH = 0.6;
const WET_GAIN = 1.75;

export class DspChain {
  private readonly sampleRate: number;
  private readonly highPassFilter = new StereoBiquad();
  private readonly bassShelf = new StereoBiquad();
  private readonly bassPeak = new StereoBiquad();
  private readonly lowMidPeak = new StereoBiquad();
  private readonly presencePeak = new StereoBiquad();
  private readonly airDamping = new StereoBiquad();
  private readonly airDamping2 = new StereoBiquad();
  private readonly sendHighPass = new StereoBiquad();
  private readonly sendLowPass = new StereoBiquad();
  private readonly saturation: Saturation;
  private readonly compressor: Compressor;
  private readonly earlyReflections: EarlyReflections;
  private readonly reverb: Reverb;
  private readonly limiter: Limiter;
  private readonly dryLeft: Float32Array;
  private readonly dryRight: Float32Array;
  private readonly sendLeft: Float32Array;
  private readonly sendRight: Float32Array;
  private readonly earlyLeft: Float32Array;
  private readonly earlyRight: Float32Array;
  private readonly lateLeft: Float32Array;
  private readonly lateRight: Float32Array;
  private readonly duckLowpassCoefficient: number;
  private readonly duckAttackCoefficient: number;
  private readonly duckReleaseCoefficient: number;
  private params: DspParams;
  private duckState = 0;
  private duckEnvelope = 0;

  private smoothInputGain = 1;
  private smoothBassDb = 0;
  private smoothBassFrequency = 90;
  private smoothLowMidCutDb = 0;
  private smoothLowMidFrequency = 350;
  private smoothPresenceDb = 0;
  private smoothPresenceFrequency = 1_800;
  private smoothAirDampingHz = 20_000;
  private smoothWidth = 1;
  private smoothDistance = 0;
  private smoothSaturation = 0;
  private smoothEarlyReflections = 0;
  private smoothReverbMix = 0;
  private smoothReverbSize = 0.6;
  private smoothReverbDamping = 0.45;
  private smoothReverbPredelayMs = 20;
  private smoothReverbDuck = 0;
  private smoothOutputGain = 1;
  private smoothWet = 1;

  constructor(sampleRate: number, initialParams: DspParams, maxBlockFrames: number) {
    this.sampleRate = sampleRate;
    this.params = initialParams;
    this.compressor = new Compressor(sampleRate);
    this.saturation = new Saturation(sampleRate);
    this.earlyReflections = new EarlyReflections(sampleRate);
    this.reverb = new Reverb(sampleRate);
    this.limiter = new Limiter(sampleRate);
    this.dryLeft = new Float32Array(maxBlockFrames);
    this.dryRight = new Float32Array(maxBlockFrames);
    this.sendLeft = new Float32Array(maxBlockFrames);
    this.sendRight = new Float32Array(maxBlockFrames);
    this.earlyLeft = new Float32Array(maxBlockFrames);
    this.earlyRight = new Float32Array(maxBlockFrames);
    this.lateLeft = new Float32Array(maxBlockFrames);
    this.lateRight = new Float32Array(maxBlockFrames);
    this.duckLowpassCoefficient = 1 - Math.exp((-2 * Math.PI * DUCK_LOWPASS_HZ) / sampleRate);
    this.duckAttackCoefficient = 1 - Math.exp(-1 / (DUCK_ATTACK_SECONDS * sampleRate));
    this.duckReleaseCoefficient = 1 - Math.exp(-1 / (DUCK_RELEASE_SECONDS * sampleRate));

    this.highPassFilter.setCoefficients(highPass(sampleRate, 30));
    this.sendHighPass.setCoefficients(highPass(sampleRate, 250));
    this.sendLowPass.setCoefficients(lowPass(sampleRate, 5_000, Math.SQRT1_2));

    this.updateSmoothedValues(1);
    this.applyBlockParameters();
  }

  setParams(params: DspParams): void {
    this.params = params;
  }

  reset(): void {
    this.highPassFilter.reset();
    this.bassShelf.reset();
    this.bassPeak.reset();
    this.lowMidPeak.reset();
    this.presencePeak.reset();
    this.airDamping.reset();
    this.airDamping2.reset();
    this.sendHighPass.reset();
    this.sendLowPass.reset();
    this.saturation.reset();
    this.compressor.reset();
    this.earlyReflections.reset();
    this.reverb.reset();
    this.limiter.reset();
    this.duckState = 0;
    this.duckEnvelope = 0;
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

    const inputGain = this.smoothInputGain * HEADROOM_TRIM;
    for (let index = 0; index < frames; index += 1) {
      left[index] = left[index]! * inputGain;
      right[index] = right[index]! * inputGain;
    }

    this.highPassFilter.processBlock(left, right, 0, frames);
    this.bassShelf.processBlock(left, right, 0, frames);
    this.bassPeak.processBlock(left, right, 0, frames);
    this.lowMidPeak.processBlock(left, right, 0, frames);
    this.presencePeak.processBlock(left, right, 0, frames);
    this.airDamping.processBlock(left, right, 0, frames);
    this.airDamping2.processBlock(left, right, 0, frames);
    this.saturation.processBlock(left, right, 0, frames);
    this.compressor.processBlock(left, right, 0, frames);

    for (let index = 0; index < frames; index += 1) {
      this.sendLeft[index] = left[index]!;
      this.sendRight[index] = right[index]!;
    }
    this.sendHighPass.processBlock(this.sendLeft, this.sendRight, 0, frames);
    this.sendLowPass.processBlock(this.sendLeft, this.sendRight, 0, frames);

    const width = this.smoothWidth;
    for (let index = 0; index < frames; index += 1) {
      const leftSample = left[index]!;
      const rightSample = right[index]!;
      const mid = (leftSample + rightSample) * 0.5;
      const side = (leftSample - rightSample) * 0.5 * width;
      left[index] = mid + side;
      right[index] = mid - side;
      this.earlyLeft[index] = 0;
      this.earlyRight[index] = 0;
      this.lateLeft[index] = 0;
      this.lateRight[index] = 0;
    }

    const distance = this.smoothDistance;
    const directGain = 1 - 0.3 * distance;
    const earlyLevel = this.smoothEarlyReflections * (0.5 + distance);
    const lateLevel = 0.6 + 0.6 * distance;
    const wetMix = Math.min(1.5, this.smoothReverbMix * WET_GAIN);

    if (wetMix > 0.0005 && (earlyLevel > 0.0005 || lateLevel > 0.0005)) {
      this.earlyReflections.process(
        this.sendLeft,
        this.sendRight,
        this.earlyLeft,
        this.earlyRight,
        0,
        frames,
      );
      if (lateLevel > 0.0005) {
        this.reverb.process(
          this.earlyLeft,
          this.earlyRight,
          this.lateLeft,
          this.lateRight,
          0,
          frames,
        );
      }
    }

    const duckEnabled = this.smoothReverbDuck > 0.0005;
    const duckDepth = this.smoothReverbDuck * DUCK_DEPTH;
    for (let index = 0; index < frames; index += 1) {
      let duck = 1;
      if (duckEnabled) {
        const mono = (left[index]! + right[index]!) * 0.5;
        this.duckState += (mono - this.duckState) * this.duckLowpassCoefficient;
        const magnitude = Math.abs(this.duckState);
        const coefficient =
          magnitude > this.duckEnvelope
            ? this.duckAttackCoefficient
            : this.duckReleaseCoefficient;
        this.duckEnvelope += (magnitude - this.duckEnvelope) * coefficient;
        duck = 1 - duckDepth * Math.min(1, this.duckEnvelope * 3);
      }
      const wet =
        (this.earlyLeft[index]! * earlyLevel + this.lateLeft[index]! * lateLevel) *
        wetMix *
        duck;
      const wetRightValue =
        (this.earlyRight[index]! * earlyLevel + this.lateRight[index]! * lateLevel) *
        wetMix *
        duck;
      left[index] = left[index]! * directGain + wet;
      right[index] = right[index]! * directGain + wetRightValue;
    }

    const outputGain = this.smoothOutputGain * HEADROOM_MAKEUP;
    for (let index = 0; index < frames; index += 1) {
      left[index] = left[index]! * outputGain;
      right[index] = right[index]! * outputGain;
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
    this.smoothLowMidCutDb = smooth(this.smoothLowMidCutDb, params.lowMidCutDb, coefficient);
    this.smoothLowMidFrequency = smooth(
      this.smoothLowMidFrequency,
      params.lowMidFrequency,
      coefficient,
    );
    this.smoothPresenceDb = smooth(this.smoothPresenceDb, params.presenceDb, coefficient);
    this.smoothPresenceFrequency = smooth(
      this.smoothPresenceFrequency,
      params.presenceFrequency,
      coefficient,
    );
    this.smoothAirDampingHz = smooth(this.smoothAirDampingHz, params.airDampingHz, coefficient);
    this.smoothWidth = smooth(this.smoothWidth, params.width, coefficient);
    this.smoothDistance = smooth(this.smoothDistance, params.distance, coefficient);
    this.smoothSaturation = smooth(this.smoothSaturation, params.saturation, coefficient);
    this.smoothEarlyReflections = smooth(
      this.smoothEarlyReflections,
      params.earlyReflections,
      coefficient,
    );
    this.smoothReverbMix = smooth(this.smoothReverbMix, params.reverbMix, coefficient);
    this.smoothReverbSize = smooth(this.smoothReverbSize, params.reverbSize, coefficient);
    this.smoothReverbDamping = smooth(
      this.smoothReverbDamping,
      params.reverbDamping,
      coefficient,
    );
    this.smoothReverbPredelayMs = smooth(
      this.smoothReverbPredelayMs,
      params.reverbPredelayMs,
      coefficient,
    );
    this.smoothReverbDuck = smooth(this.smoothReverbDuck, params.reverbDuck, coefficient);
    this.smoothOutputGain = smooth(this.smoothOutputGain, dbToGain(params.outputGainDb), coefficient);
    this.smoothWet = smooth(this.smoothWet, params.effectsEnabled ? 1 : 0, coefficient);
  }

  private applyBlockParameters(): void {
    const airCutoff = Math.max(3_000, this.smoothAirDampingHz * (1 - 0.45 * this.smoothDistance));
    this.bassShelf.setCoefficients(
      lowShelf(
        this.sampleRate,
        Math.min(400, this.smoothBassFrequency * 1.9),
        this.smoothBassDb * 0.45,
      ),
    );
    this.bassPeak.setCoefficients(
      peaking(this.sampleRate, this.smoothBassFrequency, this.smoothBassDb * 0.55, 1.1),
    );
    this.lowMidPeak.setCoefficients(
      peaking(this.sampleRate, this.smoothLowMidFrequency, this.smoothLowMidCutDb, 1),
    );
    this.presencePeak.setCoefficients(
      peaking(this.sampleRate, this.smoothPresenceFrequency, this.smoothPresenceDb, 0.9),
    );
    this.airDamping.setCoefficients(lowPass(this.sampleRate, airCutoff, Math.SQRT1_2));
    this.airDamping2.setCoefficients(lowPass(this.sampleRate, airCutoff, Math.SQRT1_2));
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
      predelayMs: this.smoothReverbPredelayMs,
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
