import { describe, expect, it } from "vitest";
import { highPass, lowShelf } from "./biquad.js";
import { StereoBiquad } from "./biquad.js";
import { Compressor } from "./compressor.js";
import { Limiter } from "./limiter.js";
import { Reverb } from "./reverb.js";
import { Saturation } from "./saturation.js";
import { DspChain } from "./chain.js";
import { PRESETS } from "../shared/presets.js";
import { SAMPLE_RATE } from "../shared/types.js";

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
  it("tames peaks without producing invalid samples", () => {
    const saturation = new Saturation();
    saturation.setAmount(1);
    const left = new Float32Array([2, -2, 0.25, -0.25]);
    const right = new Float32Array([-2, 2, -0.25, 0.25]);
    saturation.processBlock(left, right, 0, 4);
    for (const sample of [...left, ...right]) {
      expect(Number.isFinite(sample)).toBe(true);
      expect(Math.abs(sample)).toBeLessThan(2);
    }
    expect(Math.abs(left[0]!)).toBeLessThan(2);
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
    let power = 0;
    const start = SR - 4_800;
    for (let index = start; index < SR; index += 1) power += left[index]! ** 2;
    const rms = Math.sqrt(power / 4_800);
    expect(rms).toBeLessThan(0.3);
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
});

describe("reverb", () => {
  it("produces a decaying tail after an impulse", () => {
    const reverb = new Reverb(SR);
    reverb.configure({ size: 0.8, damping: 0.4, sampleRate: SR });
    const block = 256;
    const left = new Float32Array(block);
    const right = new Float32Array(block);
    left[0] = 1;
    right[0] = 1;
    reverb.processBlock(left, right, 0, block, 1);
    let earlyEnergy = 0;
    let lateEnergy = 0;
    for (let offset = 0; offset < 200; offset += 1) {
      left.fill(0);
      right.fill(0);
      reverb.processBlock(left, right, 0, block, 1);
      let energy = 0;
      for (let index = 0; index < block; index += 1) {
        energy += left[index]! ** 2 + right[index]! ** 2;
      }
      if (offset >= 5 && offset < 25) earlyEnergy += energy;
      if (offset >= 150) lateEnergy += energy;
    }
    expect(earlyEnergy).toBeGreaterThan(0);
    expect(lateEnergy).toBeLessThan(earlyEnergy);
    expect(Number.isFinite(lateEnergy)).toBe(true);
  });
});

describe("chain", () => {
  it("passes the dry signal through untouched when bypassed", () => {
    const params = { ...PRESETS[0]!.params, effectsEnabled: false };
    const chain = new DspChain(SR, params, 256);
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
      expect(left[index]).toBeCloseTo(sourceLeft[index]!, 6);
      expect(right[index]).toBeCloseTo(sourceRight[index]!, 6);
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
});
