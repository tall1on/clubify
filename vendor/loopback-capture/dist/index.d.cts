//#region js/index.d.ts
type LoopbackCaptureStats = {
  deliveredPackets: number;
  deliveredBytes: number;
  droppedPackets: number;
  droppedBytes: number;
};
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
  /** Clubify fork: delivery and drop counters, including tap ring overflows. */
  stats?: () => LoopbackCaptureStats;
  /** Capture the default system output, or pass excludeProcessId to mix playback streams outside that process tree across devices. Linux skips streams whose ownership cannot be determined. */
  startSystemAudio: (callback: (chunk: Buffer) => void, excludeProcessId?: number) => void;
  /**
   * Clubify fork: inject the Spotify tap DLL, read its shared-memory ring, and
   * silence Spotify while a reader heartbeat is present. Windows x64 only.
   */
  startTap?: (
    processId: number,
    dllPath: string,
    callback: (chunk: Buffer) => void,
    sampleRate: number,
  ) => { sampleRate: number; channels: number };
};
type OutputDeviceInfo = {
  name: string;
  isDefault: boolean;
  channels: number;
  sampleRate: number;
};
type OpenedAudioOutput = {
  deviceName: string;
  sampleRate: number;
  periodFrames: number;
  warning: string | null;
};
type AudioOutputStats = {
  fillFrames: number;
  capacityFrames: number;
  underruns: number;
  silentFrames: number;
  droppedFrames: number;
  fatal: string | null;
};
type AudioOutput = {
  /** Opens a WASAPI shared-mode render stream fed by a one-second native ring. */
  open: (deviceName: string | null, sampleRate: number) => OpenedAudioOutput;
  /** Copies interleaved stereo float32 frames into the ring; returns dropped frames. */
  push: (buffer: Buffer) => number;
  stats: () => AudioOutputStats;
  /** Clears underrun/overrun counters when real playback starts. */
  resetStats: () => void;
  stop: () => void;
  readonly isOpen: boolean;
};
type Addon = {
  /** True when this build supports startWithFormat and 32-bit float capture. */
  supportsFloat32?: boolean;
  /** True when this build includes the Windows Spotify tap reader/injector. */
  supportsTap?: boolean;
  /** True when this build includes the native WASAPI render output. */
  supportsOutput?: boolean;
  /** Windows x64: matching PIDs with the real main process first. */
  findProcessTree?: (imageName: string) => number[];
  /** Windows x64: active render endpoints with friendly names and mix formats. */
  listOutputDevices?: () => OutputDeviceInfo[];
  /** Windows x64: the device's preferred shared-mode sample rate. */
  preferredOutputRate?: (deviceName: string | null) => number;
  AudioOutput?: {
    new (): AudioOutput;
  };
  LoopbackCapture: {
    new (): LoopbackCapture;
  };
};
declare const _default: {
  supportsFloat32?: boolean;
  supportsTap?: boolean;
  supportsOutput?: boolean;
  findProcessTree?: (imageName: string) => number[];
  listOutputDevices?: () => OutputDeviceInfo[];
  preferredOutputRate?: (deviceName: string | null) => number;
  AudioOutput?: {
    new (): AudioOutput;
  };
  LoopbackCapture: {
    new (): LoopbackCapture;
  };
};
//#endregion
export {
  Addon,
  AudioOutput,
  AudioOutputStats,
  LoopbackCapture,
  LoopbackCaptureStats,
  OpenedAudioOutput,
  OutputDeviceInfo,
  _default as default,
};
