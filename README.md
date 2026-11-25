# Clubify

Spotify-only nightclub processing for Windows. Clubify captures only the Spotify process tree with the Windows Process Loopback API, runs the audio through a bass/saturation/reverb/compression chain, and renders the result to your normal output device. Other applications are untouched.

![stack](https://img.shields.io/badge/Windows-11%20build%2020348%2B-0078D4) ![node](https://img.shields.io/badge/Node.js-20%2B-339933) ![tauri](https://img.shields.io/badge/Tauri-2-24C8DB)

## What it does

- Captures `Spotify.exe` and its descendants through WASAPI process loopback.
- 48 kHz stereo PCM, fixed-size DSP blocks, event-driven WASAPI output.
- Stereo bass shelf, soft saturation, Freeverb-style club reverb, stereo-linked compressor, limiter, and auto level.
- Five room presets plus live fine tuning and click-free bypass.
- Automatic Spotify process discovery and capture restart.
- Tauri tray app, close-to-tray, and Windows autostart in release builds.
- Browser control UI is also available for development.

## Requirements

- Windows 11 build 20348 or newer (`AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`).
- Node.js 20 or newer.
- A virtual audio cable such as VB-CABLE, or any unused output endpoint you can route Spotify to.
- For desktop builds only: Rust, Cargo, and the Visual C++ build tools plus Windows SDK.

## Why a virtual cable is required

Process loopback capture respects the captured session's mute and volume state. In testing, muting the session or setting its volume to zero also silences the process-loopback capture. There is no supported API that both captures a process and suppresses its original endpoint output.

The reliable routing is:

1. Route Spotify to a silent virtual cable (`CABLE Input`).
2. Let Clubify capture the Spotify process tree.
3. Render the processed audio to your headphones or speakers.

On Windows 11 this is configured under **Settings -> System -> Sound -> Volume mixer -> Spotify -> Output device -> CABLE Input**. Other apps stay on the normal output device.

If you play Spotify through your normal device without routing, Clubify still processes the captured audio, but you will hear the original and processed signal at the same time.

## Quick start: browser mode

```powershell
npm install
npm run ui:build
npm run engine
```

Open http://127.0.0.1:8787. The engine serves the built UI and exposes a localhost-only WebSocket control channel.

For frontend development with hot reload:

```powershell
npm run dev:all
```

This starts the engine on port 8787 and Vite on http://localhost:5173. The UI connects to the engine on 8787.

## Quick start: desktop mode

```powershell
npm run desktop:dev
```

The Tauri window starts hidden in the tray. Left-click the tray icon to open it. To show the window immediately during development:

```powershell
$env:CLUBIFY_SHOW=1
npm run desktop:dev
```

### Production installer

```powershell
npm run desktop:build
```

This does three things:

1. Compiles the engine to `dist/`.
2. Creates `src-tauri/resources/` with a portable Node runtime, the compiled engine, and the required native modules.
3. Runs `tauri build`, producing an installer under `src-tauri/target/release/bundle/`.

The packaged app starts the bundled engine automatically and does not require a system Node installation. The trade-off is a larger installer because the Node runtime is bundled.

The release build enables autostart on first launch and records that decision, so disabling autostart from the tray menu sticks across updates. The tray menu has a **Start with Windows** checkbox. Debug builds do not touch autostart.

## Controls

Presets:

- **Nightclub** — warm low end, moderate drive, medium room.
- **Deep House** — deeper bass, long tail, gentle compression.
- **Festival** — loud, forward, heavily glued.
- **Warehouse** — dirty saturation and a large concrete tail.
- **Clean** — captured signal with effects bypassed.

Main controls: bass, saturation, club reverb, compression, output gain, preset selection, bypass.

Fine tuning: input trim, bass corner frequency, reverb size and damping, compressor threshold and ratio, safety buffer, auto level, output device.

Auto level slowly normalizes quiet captures toward a music-ready level. It is on by default and can be disabled in the routing panel.

The safety buffer defaults to 48 ms. It can be raised if the machine underruns and lowered for lower latency. The reported buffer is the jitter queue; total latency also includes capture, DSP, and WASAPI output.

## Architecture

```text
Spotify.exe
   |
   |  Windows Process Loopback (include process tree)
   v
loopback-capture (Rust N-API addon)
   |
   |  16-bit stereo PCM @ 48 kHz
   v
Block assembler -> DSP chain -> jitter queue
                              |
                              v
                       audify / WASAPI render
                              |
                              v
                    headphones or speakers

Tauri app --tray/autostart--> spawns Node engine
Browser or WebView UI <--WebSocket--> engine control server
```

Project layout:

```text
src/
  audio/        capture, discovery, output, queue, engine orchestration
  dsp/          biquad, saturation, compressor, reverb, limiter, chain
  server/       config storage and localhost control server
  shared/       protocol types and presets
ui/             Vue 3 + Pinia + Vite control UI
src-tauri/      Tauri 2 shell, tray menu, autostart, engine lifecycle
scripts/        production engine packaging
```

## Configuration

The engine stores configuration at `%APPDATA%\clubify\config.json`. Set `CLUBIFY_CONFIG_DIR` to use a different directory for testing.

Useful environment overrides for development and portable builds:

- `CLUBIFY_SHOW=1` — show the Tauri window immediately instead of starting in the tray.
- `CLUBIFY_NO_AUTOSTART=1` — do not enable autostart on a release launch.
- `CLUBIFY_DEBUG_CONSOLE=1` — let the bundled engine inherit the parent console in release builds.
- `CLUBIFY_ENGINE_BIN` — run a custom engine executable instead of the bundled one.
- `CLUBIFY_PACKAGED=1` — force a debug Tauri build to use the packaged resource path.

Capture is keyed on the image name `Spotify.exe`. If a Spotify distribution uses a different process name, change `spotifyImageName` in the config.

Ports are fixed at `8787` for the control server and WebSocket. The server binds to `127.0.0.1` only.

## API

- `GET /api/health` returns engine status and the connected UI client count.
- `GET /api/state` returns config, status, presets, and output devices.
- `WS /ws` accepts the typed messages in `src/shared/types.ts`.

All messages are JSON. Example:

```json
{ "type": "set-preset", "presetId": "warehouse" }
```

## Development checks

```powershell
npm test
npm run typecheck
npm run ui:typecheck
npm run ui:build
cargo check --manifest-path src-tauri/Cargo.toml
```

The audio smoke test can also be exercised without Spotify by creating a process named `Spotify.exe` that renders a tone, but it will be audible. End-to-end testing with a synthetic process produced a stable 35–40 ms queue with zero underruns on the development machine.

## Troubleshooting

**Stuck on "Waiting for Spotify"**

Spotify is open but no track is playing, or the process image name differs. Press play, then check the PID in the UI. Clubify captures the lowest `Spotify.exe` PID and includes its descendants.

**I hear Spotify twice**

Spotify is still routed to the normal output device. Route it to the virtual cable and keep Clubify's output on the headphones.

**No virtual cable detected**

Install VB-CABLE, reboot, then restart Clubify. The UI warning is informational and can be dismissed if you use per-app routing to a different silent endpoint.

**Audio is quiet or loud**

Auto level adapts slowly by design. Use input trim for manual gain and output gain for the final level. Auto level can be disabled.

**Clicks, dropouts, or underruns**

Raise the safety buffer, close CPU-heavy applications, or choose a different output device. The engine drops data rather than growing latency without bound; the overrun counter records that.

**Desktop window is not visible**

The app starts in the tray. Left-click the tray icon. Use `$env:CLUBIFY_SHOW=1` for development launches.

**Tauri build fails**

Install the Rust toolchain and the Visual Studio C++ build tools with the Windows SDK. Run `npm run package:engine` before `tauri build` if you are not using `npm run desktop:build`.

## Known limitations

- Windows x64 only for the supported capture path.
- Original audio suppression depends on routing Spotify to a virtual/silent endpoint.
- Spotify is detected by process image name, not the Spotify Web API. No login or account access is involved.
- Output is fixed at 48 kHz stereo. Devices that cannot open 48 kHz shared mode are not resampled yet.
- Total latency is typically above the 30 ms target because of shared-mode WASAPI, the virtual cable, and the jitter queue. Lower the safety buffer to trade stability for latency.
- The control server has no authentication because it binds to localhost. Do not expose port 8787.
- The production package bundles Node and therefore is substantially larger than a pure Rust Tauri app.

## Third-party components

- [loopback-capture](https://github.com/WerdoxDev/loopback-capture) — MIT, wasapi process/system loopback N-API addon.
- [audify](https://github.com/almoghamdani/audify) — MIT, RtAudio/WASAPI output and Opus bindings.
- [Tauri](https://tauri.app) — Apache-2.0/MIT.
- Node.js runtime (MIT) is bundled in production builds.
