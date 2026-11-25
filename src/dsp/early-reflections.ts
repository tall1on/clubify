const TAP_TIMES_MS = [3.5, 5.5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 43];
const TAP_GAINS = [0.5, 0.45, 0.72, 0.66, 0.62, 0.58, 0.52, 0.47, 0.42, 0.38, 0.33, 0.28];
const TAP_PANS = [0.1, -0.15, -0.85, 0.8, -0.6, 0.65, -0.4, 0.45, -0.2, 0.25, -0.05, 0.1];
const DAMPING_HZ = 4_500;

export class EarlyReflections {
  private readonly buffer: Float32Array;
  private writeIndex = 0;
  private readonly delays: Int32Array;
  private readonly leftGains: Float32Array;
  private readonly rightGains: Float32Array;
  private readonly dampingStates: Float32Array;
  private readonly dampingCoefficient: number;

  constructor(sampleRate: number) {
    const delays = TAP_TIMES_MS.map((ms) =>
      Math.max(1, Math.round((ms / 1_000) * sampleRate)),
    );
    this.delays = Int32Array.from(delays);
    const longest = Math.max(...delays) + 2;
    this.buffer = new Float32Array(longest);
    this.dampingStates = new Float32Array(TAP_TIMES_MS.length);
    this.dampingCoefficient = 1 - Math.exp((-2 * Math.PI * DAMPING_HZ) / sampleRate);

    const gainSum = TAP_GAINS.reduce((sum, gain) => sum + gain, 0);
    this.leftGains = new Float32Array(TAP_GAINS.length);
    this.rightGains = new Float32Array(TAP_GAINS.length);
    for (let tap = 0; tap < TAP_GAINS.length; tap += 1) {
      const pan = ((TAP_PANS[tap]! + 1) * Math.PI) / 4;
      const gain = TAP_GAINS[tap]! / gainSum;
      this.leftGains[tap] = gain * Math.cos(pan);
      this.rightGains[tap] = gain * Math.sin(pan);
    }
  }

  reset(): void {
    this.buffer.fill(0);
    this.dampingStates.fill(0);
    this.writeIndex = 0;
  }

  process(
    sendLeft: Float32Array,
    sendRight: Float32Array,
    wetLeft: Float32Array,
    wetRight: Float32Array,
    offset: number,
    length: number,
  ): void {
    const size = this.buffer.length;
    const damping = this.dampingCoefficient;
    for (let index = offset; index < offset + length; index += 1) {
      const input = (sendLeft[index]! + sendRight[index]!) * 0.5;
      this.buffer[this.writeIndex] = input;
      let left = 0;
      let right = 0;
      for (let tap = 0; tap < this.delays.length; tap += 1) {
        const readIndex = (this.writeIndex - this.delays[tap]! + size) % size;
        let sample = this.buffer[readIndex]!;
        const state = this.dampingStates[tap]!;
        const filtered = state + (sample - state) * damping;
        this.dampingStates[tap] = filtered;
        sample = filtered;
        left += sample * this.leftGains[tap]!;
        right += sample * this.rightGains[tap]!;
      }
      wetLeft[index] = wetLeft[index]! + left;
      wetRight[index] = wetRight[index]! + right;
      this.writeIndex += 1;
      if (this.writeIndex >= size) this.writeIndex = 0;
    }
  }
}
