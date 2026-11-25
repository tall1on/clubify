# Development

Technical documentation for building and contributing to Clubify. For a user-facing overview, see [README.md](README.md).

## Requirements

- Windows 11 build 20348 or newer (`AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`).
- Node.js 20 or newer.
- A virtual audio cable such as VB-CABLE, or any unused output endpoint you can route Spotify to.
- For desktop builds only: Rust, Cargo, and the Visual C++ build tools plus Windows SDK.
- Rebuilding the bundled capture fork requires Rust 1.88+ and the Windows SDK. A prebuilt Windows x64 addon is committed, so normal installs do not need Rust.

## Quick start: browser mode

```powershell
npm install
npm run ui:build
npm run engine
```

Open http://127.0.0.1:8787. The engine serves the built UI and exposes a localhost-only WebSocket control channel.

`npm install` uses the vendored capture fork in `vendor/loopback-capture`. A prebuilt `win32-x64` addon is included. If it is missing or you changed the Rust source, rebuild it with:

```powershell
npm run build:capture
```

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

## Production installer

```powershell
npm run desktop:build
```

This does three things:

1. Compiles the engine to `dist/`.
2. Creates `src-tauri/resources/` with a portable Node runtime, the compiled engine, and the required native modules.
3. Runs `tauri build`, producing an installer under `src-tauri/target/release/bundle/`.

The packaged app starts the bundled engine automatically and does not require a system Node installation. The trade-off is a larger installer because the Node runtime is bundled.

The release build enables autostart on first launch and records that decision, so disabling autostart from the tray menu sticks across updates. The tray menu has a **Start with Windows** checkbox. Debug builds do not touch autostart.

## Releases and auto-updates

Release builds update themselves from GitHub Releases. They check `https://github.com/tall1on/clubify/releases/latest/download/latest.json` on start and then every six hours, download the signed NSIS installer when a newer version is published, stop the bundled engine, install, and relaunch. Check results and failures are appended to `%LOCALAPPDATA%\com.clubify.audio\logs\updater.log` so problems are visible even though release builds have no console.

The release workflow (`.github/workflows/release.yml`) runs on a self-hosted Windows x64 runner when the version changes on `main`. It builds the engine, produces NSIS and signed updater artifacts, uploads them to a **draft** GitHub release, and only publishes the release after every asset, including `latest.json`, has uploaded successfully. A failed build therefore never becomes "latest", so installed copies keep seeing the last complete release instead of a 404. The workflow can also be started manually with `workflow_dispatch`.

If a release run fails, fix the cause and rerun the job (or run `workflow_dispatch` for the same version). The leftover draft is reused and published after a successful upload. To remove a broken public release created by an older workflow, run `gh release delete v0.2.0 --cleanup-tag --yes` and then dispatch the workflow again if that version still needs to ship.

Bump every manifest at once, then push:

```powershell
npm run version:bump -- 0.2.0
git add package.json package-lock.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "release 0.2.0"
git push origin main
```

The updater keypair was generated with `npx tauri signer generate -w "$env:USERPROFILE\.tauri\clubify.key"`. The public key is embedded in `src-tauri/tauri.conf.json`. Add the private key file contents as the `TAURI_SIGNING_PRIVATE_KEY` repository secret, plus `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` if the key has a password. Keep the private key safe: installed copies cannot verify updates signed with a different key. Builds made before the updater was added have to be replaced manually once.

The self-hosted runner needs the `self-hosted`, `Windows`, and `X64` labels, Node.js 20, Rust, and the Visual Studio C++ build tools with the Windows SDK. GitHub Releases must be publicly readable because the updater does not ship a GitHub token. `npm run desktop:build` still produces unsigned local bundles; signed updater artifacts are created only by the release workflow.

## Architecture

```text
Spotify.exe (FLAC 24-bit / 44.1 kHz, decoded by Spotify)
   |
   |  Windows audio engine, float32 at the cable endpoint rate
   v
Windows Process Loopback (include process tree)
   |
   v
vendor/loopback-capture (Rust N-API fork)
   |
   |  float32 stereo at the engine rate
   |  AUTOCONVERTPCM + SRC_DEFAULT_QUALITY
   |  silent packets delivered as zeros
   v
Block assembler -> float32 DSP chain -> sinc drift queue (unity deadband)
                                                    |
                                                    v
                                    audify / WASAPI float32 render
                                                    |
                                                    v
                                         headphones or speakers

Tauri app --tray/autostart--> spawns Node engine
Browser or WebView UI <--WebSocket--> engine control server
```

The engine follows the selected output device's preferred sample rate. Capture requests that same rate and format, so with the cable and output device both set to the same rate the path does no sample-rate conversion at all. The drift queue only corrects clock mismatch between the two devices, using a 32-tap windowed-sinc interpolator and staying on exactly 1.0 while the buffer is within its deadband.

Project layout:

```text
src/
  audio/        capture, discovery, output, queue, engine orchestration
  dsp/          biquad, saturation, compressor, reverb, limiter, chain
  server/       config storage and localhost control server
  shared/       protocol types and presets
ui/             Vue 3 + Pinia + Vite control UI
src-tauri/      Tauri 2 shell, tray menu, autostart, engine lifecycle
scripts/        production engine packaging and license generation
licenses/       curated license-text overrides for packages that ship without a license file
vendor/         vendored loopback-capture fork (Rust) and its prebuilt addon
```

## Configuration

The engine stores configuration at `%APPDATA%\clubify\config.json`. Set `CLUBIFY_CONFIG_DIR` to use a different directory for testing.

Useful environment overrides for development and portable builds:

- `CLUBIFY_SHOW=1` — show the Tauri window immediately instead of starting in the tray.
- `CLUBIFY_NO_AUTOSTART=1` — do not enable autostart on a release launch.
- `CLUBIFY_DEBUG_CONSOLE=1` — let the bundled engine inherit the parent console in release builds.
- `CLUBIFY_ENGINE_BIN` — run a custom engine executable instead of the bundled one.
- `CLUBIFY_PACKAGED=1` — force a debug Tauri build to use the packaged resource path.
- `CLUBIFY_UPDATE_CHECK=1` — run the updater from a debug build.
- `CLUBIFY_UPDATE_INTERVAL_SECS` — seconds between update checks (default `21600`, six hours). Lower it while testing the updater.

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
npm run licenses:generate
npm run licenses:check
npm run build:capture
cargo check --manifest-path vendor/loopback-capture/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
```

`npm run build:capture` rebuilds the vendored native addon and updates `vendor/loopback-capture/build/Release/loopback_capture_addon.node`. The audio smoke test can also be exercised without Spotify by creating a process named `Spotify.exe` that renders a tone, but it will be audible. End-to-end testing with a synthetic process produced a stable 35–40 ms queue with zero underruns on the development machine.

## Licenses

The in-app license page is generated, not hand-maintained. `npm run licenses:generate` writes `ui/public/licenses.json` from:

- `LICENSE` and `package.json` for the project license.
- The installed npm production dependency tree from `package-lock.json` and `node_modules`.
- `cargo tree` and `cargo metadata` for `src-tauri/Cargo.toml` and `vendor/loopback-capture/Cargo.toml`, resolved for the Windows target.
- Optional `licenses/overrides/<npm|cargo>/<package>.txt` files when a package distributes a license identifier but no license text.

The generator runs automatically before `ui:dev`, `ui:build`, and `desktop:build`. After adding or upgrading a dependency, run it directly and commit the refreshed `ui/public/licenses.json`. The script stays successful without Cargo by keeping previously generated Rust entries, and it is never necessary to edit `licenses.json` by hand. `ui:build` uses `licenses:check`, which fails the build if any package has no license text and no override, so new dependencies cannot silently ship without a notice.

## Developer troubleshooting

**The engine reports "bundled loopback-capture fork is required"**
The patched addon is missing. Run `npm run build:capture`, then `npm install` again if `node_modules` still points at the upstream package.

**The UI shows different capture and engine rates**
The engine follows the output device, and capture requests the same rate. If the capture rate differs, the cable endpoint rejected the requested format; set the cable and output device to the same rate in Windows Sound settings and restart Clubify.

**Desktop window is not visible**
The app starts in the tray. Left-click the tray icon. Use `$env:CLUBIFY_SHOW=1` for development launches.

**Tauri build fails**
Install the Rust toolchain and the Visual Studio C++ build tools with the Windows SDK. Run `npm run package:engine` before `tauri build` if you are not using `npm run desktop:build`.

**An update was published but Clubify did not update**
Check `%LOCALAPPDATA%\com.clubify.audio\logs\updater.log`. A 404 there means the latest GitHub release has no `latest.json` or installer assets. The updater checks at start and every six hours; choose **Quit** from the tray and relaunch to force an immediate check.

## Technical limitations

- Windows x64 only for the supported capture path.
- Original audio suppression depends on routing Spotify to a virtual/silent endpoint.
- Output is float32 stereo at the output device's preferred rate. Devices that cannot open that rate in shared mode fall back to 48 kHz and are resampled by Windows.
- Capture uses the vendored `loopback-capture` fork in `vendor/loopback-capture`. It is pinned; upstream changes need to be merged manually. Rebuild it with `npm run build:capture` after changing the Rust source.
- Total latency is typically above the 30 ms target because of shared-mode WASAPI, the virtual cable, the jitter queue, and the limiter lookahead. Lower the safety buffer to trade stability for latency.
- The control server has no authentication because it binds to localhost. Do not expose port 8787.
- The production package bundles Node and therefore is substantially larger than a pure Rust Tauri app.
