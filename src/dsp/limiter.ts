const LOOKAHEAD_SECONDS = 0.003;
const CEILING = 0.95;
const SOFT_KNEE = 0.995;
const RELEASE_SECONDS = 0.12;

export class Limiter {
  private readonly lookahead: number;
  private readonly delayLeft: Float32Array;
  private readonly delayRight: Float32Array;
  private delayIndex = 0;
  private gain = 1;
  private readonly attackCoefficient: number;
  private readonly releaseCoefficient: number;
  private readonly window: Float32Array;
  private readonly deque: Int32Array;
  private dequeHead = 0;
  private dequeTail = 0;
  private dequeCount = 0;
  private position = 0;

  constructor(sampleRate: number) {
    this.lookahead = Math.max(1, Math.round(LOOKAHEAD_SECONDS * sampleRate));
    this.delayLeft = new Float32Array(this.lookahead);
    this.delayRight = new Float32Array(this.lookahead);
    this.window = new Float32Array(this.lookahead + 1);
    this.deque = new Int32Array(this.lookahead + 2);
    this.attackCoefficient = 1 - Math.exp(-3 / this.lookahead);
    this.releaseCoefficient = 1 - Math.exp(-1 / (RELEASE_SECONDS * sampleRate));
  }

  reset(): void {
    this.delayLeft.fill(0);
    this.delayRight.fill(0);
    this.window.fill(0);
    this.gain = 1;
    this.delayIndex = 0;
    this.dequeHead = 0;
    this.dequeTail = 0;
    this.dequeCount = 0;
    this.position = 0;
  }

  processBlock(
    left: Float32Array,
    right: Float32Array,
    offset: number,
    length: number,
  ): void {
    const size = this.window.length;
    for (let index = offset; index < offset + length; index += 1) {
      const position = this.position;
      const slot = position % size;
      const magnitude = Math.max(Math.abs(left[index]!), Math.abs(right[index]!));
      this.window[slot] = magnitude;

      while (this.dequeCount > 0) {
        const last = this.deque[(this.dequeTail - 1 + this.deque.length) % this.deque.length]!;
        if (this.window[last % size]! > magnitude) break;
        this.dequeTail = (this.dequeTail - 1 + this.deque.length) % this.deque.length;
        this.dequeCount -= 1;
      }
      this.deque[this.dequeTail] = position;
      this.dequeTail = (this.dequeTail + 1) % this.deque.length;
      this.dequeCount += 1;

      const oldest = position - this.lookahead;
      while (this.dequeCount > 0) {
        const head = this.deque[this.dequeHead]!;
        if (head >= oldest) break;
        this.dequeHead = (this.dequeHead + 1) % this.deque.length;
        this.dequeCount -= 1;
      }

      const windowPeak = this.window[this.deque[this.dequeHead]! % size]!;
      const targetGain = windowPeak > CEILING ? CEILING / windowPeak : 1;
      const coefficient =
        targetGain < this.gain ? this.attackCoefficient : this.releaseCoefficient;
      this.gain += (targetGain - this.gain) * coefficient;

      const delayedLeft = this.delayLeft[this.delayIndex]!;
      const delayedRight = this.delayRight[this.delayIndex]!;
      this.delayLeft[this.delayIndex] = left[index]!;
      this.delayRight[this.delayIndex] = right[index]!;
      this.delayIndex += 1;
      if (this.delayIndex >= this.lookahead) this.delayIndex = 0;

      left[index] = softClip(delayedLeft * this.gain);
      right[index] = softClip(delayedRight * this.gain);
      this.position = position + 1;
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
