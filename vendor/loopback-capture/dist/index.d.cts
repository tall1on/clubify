//#region js/index.d.ts
type LoopbackCapture = {
  /** Terminal native capture failure, or null while idle/healthy. Read before stop(), which clears the session. */
  readonly lastError: string | null;
  /** Capture a process and all its descendants, including streams created after capture starts. Linux ownership detection is best effort. */
  start(processId: number, callback: (chunk: Buffer) => void): void;
  /**
   * Capture a process with an explicit sample format and rate.
   * Clubify fork: "f32" delivers interleaved little-endian float32 and preserves silent packets as zeros.
   */
  startWithFormat: (
    processId: number,
    callback: (chunk: Buffer) => void,
    format: "f32" | "s16",
    sampleRate: number,
  ) => void;
  stop: () => void;
  /** Capture the default system output, or pass excludeProcessId to mix playback streams outside that process tree across devices. Linux skips streams whose ownership cannot be determined. */
  startSystemAudio: (callback: (chunk: Buffer) => void, excludeProcessId?: number) => void;
};
type Addon = {
  /** True when this build supports startWithFormat and 32-bit float capture. */
  supportsFloat32?: boolean;
  LoopbackCapture: {
    new (): LoopbackCapture;
  };
};
declare const _default: {
  supportsFloat32?: boolean;
  LoopbackCapture: {
    new (): LoopbackCapture;
  };
};
//#endregion
export { Addon, LoopbackCapture, _default as default };
