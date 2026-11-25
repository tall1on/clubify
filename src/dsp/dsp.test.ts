import { describe, expect, it } from "vitest";
import { highPass, lowShelf } from "./biquad.js";
import { StereoBiquad } from "./biquad.js";
import { Compressor } from "./compressor.js";
import { EarlyReflections } from "./early-reflections.js";
import { Limiter } from "./limiter.js";
import { Reverb } from "./reverb.js";
import { Saturation } from "./saturation.js";
import { DspChain } from "./chain.js";
import {
  DEFAULT_PRESET_ID,
  PRESETS,
  clampParams,
  defaultEffects,
  getPreset,
  neutralEffects,
} from "../shared/presets.js";

const SR = 48_000;

function stereoBiquadGain(
  coefficients: ReturnType<typeof lowShelf>,
  frequency: number,
): number {
  const filter = new StereoBiquad();
  filter.setCoefficients(coefficients);
  const total = SR;
  const left = new Float32Array(total);
  const right = new Float32Array(total);
  for (let index = 0; index < total; index += 1) {
    const sample = Math.sin((2 * Math.PI * frequency * index) / SR);
    left[index] = sample;
    right[index] = sample;
  }
  filter.processBlock(left, right, 0, total);
  let power = 0;
  const start = Math.floor(total * 0.5);
  for (let index = start; index < total; index += 1) power += left[index]! ** 2;
  return Math.sqrt(power / (total - start));
}

function sine(frequency: number, amplitude: number, frames = SR): [Float32Array, Float32Array] {
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let index = 0; index < frames; index += 1) {
    const sample = Math.sin((2 * Math.PI * frequency * index) / SR) * amplitude;
    left[index] = sample;
    right[index] = sample;
  }
  return [left, right];
}

function rms(samples: Float32Array, start: number): number {
  let power = 0;
  for (let index = start; index < samples.length; index += 1) power += samples[index]! ** 2;
  return Math.sqrt(power / (samples.length - start));
}

describe("biquad", () => {
  it("boosts the low end more than the highs for a bass shelf", () => {
    const coefficients = lowShelf(SR, 90, 12);
    const lowGain = stereoBiquadGain(coefficients, 60);
    const highGain = stereoBiquadGain(coefficients, 2_000);
    expect(20 * Math.log10(lowGain / highGain)).toBeGreaterThan(7);
  });

  it("removes DC with a high-pass filter", () => {
    const filter = new StereoBiquad();
    filter.setCoefficients(highPass(SR, 26));
    const left = new Float32Array(4_800).fill(0.5);
    const right = new Float32Array(4_800).fill(0.5);
    filter.processBlock(left, right, 0, 4_800);
    expect(Math.abs(left[4_799]!)).toBeLessThan(0.01);
  });
});

describe("saturation", () => {
  it("leaves the high band almost untouched", () => {
    const saturation = new Saturation(SR);
    saturation.setAmount(1);
    const [left, right] = sine(5_000, 0.4);
    const inputRms = rms(left, 0);
    saturation.processBlock(left, right, 0, left.length);
    const outputRms = rms(left, SR / 2);
    expect(outputRms / inputRms).toBeGreaterThan(0.95);
    expect(outputRms / inputRms).toBeLessThan(1.05);
  });

  it("compresses low-band peaks and stays finite", () => {
    const saturation = new Saturation(SR);
    saturation.setAmount(1);
    const [left, right] = sine(60, 0.6);
    const inputRms = rms(left, 0);
    saturation.processBlock(left, right, 0, left.length);
    const outputRms = rms(left, SR / 2);
    expect(outputRms).toBeLessThan(inputRms);
    expect(outputRms).toBeGreaterThan(inputRms * 0.2);
    for (const sample of left) expect(Number.isFinite(sample)).toBe(true);
  });
});

describe("compressor", () => {
  it("reduces a loud constant signal", () => {
    const compressor = new Compressor(SR);
    compressor.configure({
      amount: 1,
      thresholdDb: -30,
      ratio: 8,
      sampleRate: SR,
    });
    const left = new Float32Array(SR).fill(0.5);
    const right = new Float32Array(SR).fill(0.5);
    compressor.processBlock(left, right, 0, SR);
    const level = rms(left, SR - 4_800);
    expect(level).toBeLessThan(0.3);
  });
});

describe("limiter", () => {
  it("keeps output inside the clip ceiling", () => {
    const limiter = new Limiter(SR);
    const left = new Float32Array(4_800).fill(2);
    const right = new Float32Array(4_800).fill(-2);
    limiter.processBlock(left, right, 0, 4_800);
    for (const sample of [...left, ...right]) {
      expect(Math.abs(sample)).toBeLessThanOrEqual(1.0001);
    }
  });

  it("does not overshoot on transients with lookahead", () => {
    const limiter = new Limiter(SR);
    const [left, right] = sine(1_000, 1.8);
    limiter.processBlock(left, right, 0, left.length);
    let maxPeak = 0;
    for (const sample of left) maxPeak = Math.max(maxPeak, Math.abs(sample));
    expect(maxPeak).toBeLessThanOrEqual(1.0001);
  });
});

describe("reverb", () => {
  it("produces a dense decaying tail after an impulse", () => {
    const reverb = new Reverb(SR);
    reverb.configure({ size: 0.8, damping: 0.4, sampleRate: SR, predelayMs: 20 });
    const block = 256;
    const sendLeft = new Float32Array(block);
    const sendRight = new Float32Array(block);
    const wetLeft = new Float32Array(block);
    const wetRight = new Float32Array(block);
    sendLeft[0] = 1;
    sendRight[0] = 1;
    reverb.process(sendLeft, sendRight, wetLeft, wetRight, 0, block);
    let earlyEnergy = 0;
    let lateEnergy = 0;
    for (let offset = 0; offset < 250; offset += 1) {
      sendLeft.fill(0);
      sendRight.fill(0);
      wetLeft.fill(0);
      wetRight.fill(0);
      reverb.process(sendLeft, sendRight, wetLeft, wetRight, 0, block);
      let energy = 0;
      for (let index = 0; index < block; index += 1) {
        energy += wetLeft[index]! ** 2 + wetRight[index]! ** 2;
      }
      if (offset >= 4 && offset < 25) earlyEnergy += energy;
      if (offset >= 200) lateEnergy += energy;
    }
    expect(earlyEnergy).toBeGreaterThan(0);
    expect(lateEnergy).toBeGreaterThan(0);
    expect(lateEnergy).toBeLessThan(earlyEnergy);
    expect(Number.isFinite(lateEnergy)).toBe(true);
  });
});

describe("early reflections", () => {
  it("emits discrete taps across the first 50 ms", () => {
    const reflections = new EarlyReflections(SR);
    const sendLeft = new Float32Array(SR / 10);
    const sendRight = new Float32Array(SR / 10);
    const wetLeft = new Float32Array(SR / 10);
    const wetRight = new Float32Array(SR / 10);
    sendLeft[0] = 1;
    sendRight[0] = 1;
    reflections.process(sendLeft, sendRight, wetLeft, wetRight, 0, sendLeft.length);
    const tapEnergy = (ms: number) => {
      const at = Math.round((ms / 1_000) * SR);
      let energy = 0;
      for (let index = Math.max(0, at - 2); index < at + 3; index += 1) {
        energy += wetLeft[index]! ** 2 + wetRight[index]! ** 2;
      }
      return energy;
    };
    expect(tapEnergy(7)).toBeGreaterThan(0);
    expect(tapEnergy(43)).toBeGreaterThan(0);
    expect(tapEnergy(2)).toBeLessThan(tapEnergy(7));
  });
});

describe("presets", () => {
  it("keeps every preset inside its clamp ranges", () => {
    for (const preset of PRESETS) {
      expect(clampParams(preset.params)).toEqual(preset.params);
    }
  });

  it("defaults to the afterhours preset", () => {
    expect(getPreset(DEFAULT_PRESET_ID)).toBeDefined();
    expect(defaultEffects()).toEqual(getPreset(DEFAULT_PRESET_ID)!.params);
  });

  it("uses neutral values for new fields in old custom configs", () => {
    const neutral = neutralEffects();
    expect(neutral.width).toBe(1);
    expect(neutral.distance).toBe(0);
    expect(neutral.lowMidCutDb).toBe(0);
    expect(neutral.presenceDb).toBe(0);
    expect(neutral.airDampingHz).toBe(20_000);
    expect(neutral.earlyReflections).toBe(0);
    expect(neutral.reverbDuck).toBe(0);
  });
});

describe("chain", () => {
  it("passes the dry signal through untouched when bypassed", () => {
    const params = { ...PRESETS[0]!.params, effectsEnabled: false };
    const chain = new DspChain(SR, params, 256);
    const latency = chain.latencyFrames;
    expect(latency).toBeGreaterThan(0);
    const sourceLeft = new Float32Array(256);
    const sourceRight = new Float32Array(256);
    for (let index = 0; index < 256; index += 1) {
      sourceLeft[index] = Math.sin(index / 10) * 0.4;
      sourceRight[index] = Math.sin(index / 13) * -0.3;
    }
    const left = sourceLeft.slice();
    const right = sourceRight.slice();
    chain.processBlock(left, right, 256);
    for (let index = 0; index < 256; index += 1) {
      if (index < latency) {
        expect(left[index]).toBe(0);
        expect(right[index]).toBe(0);
      } else {
        expect(left[index]).toBeCloseTo(sourceLeft[index - latency]!, 6);
        expect(right[index]).toBeCloseTo(sourceRight[index - latency]!, 6);
      }
    }
  });

  it("stays finite and bounded with an aggressive preset", () => {
    const params = {
      ...PRESETS.find((preset) => preset.id === "warehouse")!.params,
      inputGainDb: 12,
      outputGainDb: 9,
    };
    const chain = new DspChain(SR, params, 256);
    const left = new Float32Array(256);
    const right = new Float32Array(256);
    for (let index = 0; index < 256; index += 1) {
      left[index] = Math.sin(index / 3) * 1.5;
      right[index] = Math.sin(index / 4) * -1.5;
    }
    for (let block = 0; block < 400; block += 1) {
      chain.processBlock(left, right, 256);
    }
    for (let index = 0; index < 256; index += 1) {
      expect(Number.isFinite(left[index])).toBe(true);
      expect(Number.isFinite(right[index])).toBe(true);
      expect(Math.abs(left[index]!)).toBeLessThanOrEqual(1.0001);
      expect(Math.abs(right[index]!)).toBeLessThanOrEqual(1.0001);
    }
  });

  it("runs at 44.1 and 96 kHz with a bounded limiter", () => {
    for (const rate of [44_100, 96_000]) {
      const chain = new DspChain(rate, PRESETS[0]!.params, 256);
      const left = new Float32Array(256);
      const right = new Float32Array(256);
      let maxPeak = 0;
      let finite = true;
      for (let block = 0; block < 300; block += 1) {
        for (let index = 0; index < 256; index += 1) {
          const sample = Math.sin((2 * Math.PI * 1_000 * (block * 256 + index)) / rate) * 0.6;
          left[index] = sample;
          right[index] = sample;
        }
        chain.processBlock(left, right, 256);
        for (let index = 0; index < 256; index += 1) {
          if (!Number.isFinite(left[index]) || !Number.isFinite(right[index])) finite = false;
          maxPeak = Math.max(maxPeak, Math.abs(left[index]!), Math.abs(right[index]!));
        }
      }
      expect(finite).toBe(true);
      expect(maxPeak).toBeLessThanOrEqual(1.0001);
      expect(chain.latencyFrames).toBeGreaterThan(0);
    }
  });

  it("adds room tail energy when distance increases", () => {
    const near = new DspChain(SR, { ...PRESETS[0]!.params, distance: 0 }, 256);
    const far = new DspChain(SR, { ...PRESETS[0]!.params, distance: 1 }, 256);
    const [toneLeft, toneRight] = sine(1_000, 0.3, 256);
    const nearLeft = new Float32Array(256);
    const nearRight = new Float32Array(256);
    const farLeft = new Float32Array(256);
    const farRight = new Float32Array(256);
    for (let block = 0; block < 80; block += 1) {
      nearLeft.set(toneLeft);
      nearRight.set(toneRight);
      farLeft.set(toneLeft);
      farRight.set(toneRight);
      near.processBlock(nearLeft, nearRight, 256);
      far.processBlock(farLeft, farRight, 256);
    }
    nearLeft.fill(0);
    nearRight.fill(0);
    farLeft.fill(0);
    farRight.fill(0);
    let nearEnergy = 0;
    let farEnergy = 0;
    for (let block = 0; block < 40; block += 1) {
      nearLeft.fill(0);
      nearRight.fill(0);
      farLeft.fill(0);
      farRight.fill(0);
      near.processBlock(nearLeft, nearRight, 256);
      far.processBlock(farLeft, farRight, 256);
      if (block < 5) continue;
      for (let index = 0; index < 256; index += 1) {
        nearEnergy += nearLeft[index]! ** 2 + nearRight[index]! ** 2;
        farEnergy += farLeft[index]! ** 2 + farRight[index]! ** 2;
      }
    }
    expect(farEnergy).toBeGreaterThan(nearEnergy);
  });
});
