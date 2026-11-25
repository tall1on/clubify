export class Saturation {
  private amount = 0;

  setAmount(amount: number): void {
    this.amount = Math.min(1, Math.max(0, amount));
  }

  processBlock(
    left: Float32Array,
    right: Float32Array,
    offset: number,
    length: number,
  ): void {
    if (this.amount <= 0.0001) return;
    const drive = 1 + this.amount * 10;
    const inverseDrive = 1 / drive;
    const wet = this.amount * 0.8;
    const dry = 1 - wet;
    const makeup = 1 + this.amount * 0.6;
    for (let index = offset; index < offset + length; index += 1) {
      const leftSample = left[index]!;
      const rightSample = right[index]!;
      const shapedLeft = Math.tanh(leftSample * drive) * inverseDrive * makeup;
      const shapedRight = Math.tanh(rightSample * drive) * inverseDrive * makeup;
      left[index] = leftSample * dry + shapedLeft * wet;
      right[index] = rightSample * dry + shapedRight * wet;
    }
  }
}
