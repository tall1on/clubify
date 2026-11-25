<p align="center">
  <img src="src-tauri/icons/icon.png" width="128" alt="Clubify logo">
</p>

<h1 align="center">Clubify</h1>

<p align="center">
  <strong>Make Spotify sound like it's playing in a nightclub.</strong><br>
  Clubify adds deep bass, warmth, and room echo to Spotify only. Games, Discord, and YouTube stay untouched.
</p>

<p align="center">
  <a href="https://github.com/tall1on/clubify/releases/latest"><img src="https://img.shields.io/github/v/release/tall1on/clubify?label=download" alt="Download latest release"></a>
  <img src="https://img.shields.io/badge/Windows-11%20build%2020348%2B-0078D4" alt="Windows 11 build 20348 or newer">
</p>

<!-- TODO: add a screenshot or short GIF of the Clubify window here -->

## Download

**[Download the latest version](https://github.com/tall1on/clubify/releases/latest)** and run the `Clubify_x.y.z_x64-setup.exe` installer.

- **Windows 11 only** (build 20348 or newer).
- **Updates itself.** Clubify checks for a new version when it launches and every few hours, then installs it automatically.
- **Starts with Windows.** It runs quietly in the system tray, near the clock. You can turn this off from the tray menu.
- **No account needed.** Clubify never asks for your Spotify login.

## Setup (one time, under a minute)

Clubify attaches a local audio tap to Spotify, captures the track, and silences the original. No virtual cable and no output-device routing are required.

1. **Start Spotify.**
2. **Open Clubify** from the tray (bottom-right of the taskbar, near the clock), choose your headphones or speakers as the output device, and press play in Spotify.
3. If the status says **Spotify is not silenced**, allow Clubify's Spotify tap in Windows Security or your antivirus, restart Spotify, and reopen Clubify.

The tap is a small helper injected into the local Spotify process. It only touches Spotify's audio buffer on your PC; it never talks to Spotify's servers. Some antivirus products flag process injection, so the process-loopback fallback with [VB-CABLE](https://vb-audio.com/Cable/) is still supported:

- Install VB-CABLE and set Spotify's output to **CABLE Input** in Windows **Settings → System → Sound → Volume mixer**.
- Keep Clubify's output on your headphones or speakers.

The tap measures Spotify's real render rate (often 44.1 kHz) and resamples it to Clubify's output rate, so mismatched Windows device rates are no longer a source of dropouts.

### Using it

Pick a preset and adjust **bass**, **saturation**, and **room** to taste. **Bypass** instantly turns the effects off so you can compare. Settings are saved automatically.

The tap captures Spotify's stream **before Windows mixer volume**. Use Spotify's own volume slider or the volume of Clubify's output device; the Windows per-app/device input volume does not change Clubify's captured level.

## Presets

| Preset | Sound |
| --- | --- |
| **Afterhours** | Hollow concrete room, horn-loaded PA, distant sub. The default. |
| **Nightclub** | Warm low end, moderate drive, smooth velvet room. |
| **Deep House** | Deeper bass, long tail, gentle compression. |
| **Festival** | Loud, forward, heavily glued together. |
| **Warehouse** | Dirty saturation and a large concrete tail. |
| **Clean** | Your untouched Spotify signal with effects off. |

<details>
<summary><strong>Fine tuning</strong></summary>

Main controls: bass, saturation, room level, room distance, compression, output gain, preset selection, and bypass.

Additional controls: input trim, bass corner, low-mid scoop and frequency, PA presence and frequency, air damping, stereo width, early reflections, reverb size, damping, predelay and ducking, compressor threshold and ratio, safety buffer, auto level, and output device.

Auto level slowly normalizes quiet captures toward a music-ready level. It is on by default and can be disabled in the routing panel.

The safety buffer defaults to 48 ms. Raise it if the machine underruns, or lower it for lower latency. The reported buffer is the jitter queue; total latency also includes capture, DSP, and output.

</details>

## FAQ

**Does Clubify need my Spotify account?** No. It only listens to the Spotify app's audio on your PC and never talks to Spotify's servers.

**Does it affect other apps?** No. Only the Spotify process and its children are captured and processed.

**Does Clubify still need VB-CABLE?** No. The tap silences Spotify without one. VB-CABLE is only a fallback if your security software blocks the tap.

**Why doesn't the Windows volume mixer change Clubify's level?** The tap reads Spotify's stream before Windows applies per-app and device volume. Use Spotify's own volume or the volume of Clubify's output device. This keeps the DSP input consistent and avoids double volume changes.

**Why is there a short silence when playback starts?** Clubify measures Spotify's real render rate for about 0.6 s and sets up resampling before it plays processed audio.

**Is the Spotify tap against Spotify's terms?** Clubify is unofficial and not affiliated with Spotify. It only taps local playback; it does not access accounts, the Spotify service, or DRM. It does modify the local desktop client in memory, which may conflict with Spotify's terms and can break after client updates. Use the VB-CABLE fallback if that matters to you.

**How do I turn the effects off?** Press **Bypass** in the UI.

**How do I stop it starting with Windows?** Right-click the tray icon and uncheck **Start with Windows**. The choice is remembered across updates.

**How do I update it?** You don't have to. Clubify checks for updates when it launches and every few hours, and installs them automatically.

**How do I uninstall it?** Open Windows **Settings → Apps → Installed apps**, find Clubify, and uninstall. Restart Spotify to unload the tap. If you used the VB-CABLE fallback, set Spotify's output device back to your normal speakers.

**Windows showed a security warning.** If SmartScreen appears, choose **More info → Run anyway**. If your antivirus specifically blocks the Spotify tap, allow it or use the VB-CABLE fallback; do not disable your antivirus globally.

**Is it bit-perfect / lossless?** Close. See [Best quality with Spotify Lossless](#best-quality-with-spotify-lossless) below.

## Troubleshooting

**Stuck on "Waiting for Spotify"**
Spotify is open but nothing is playing, or the process name is different. Press play, then check the PID shown in the UI. Clubify identifies the real main `Spotify.exe` process and its children.

**I hear Spotify twice**
The tap is not silencing Spotify. Open the UI: if the status says **Spotify is not silenced**, allow Clubify in Windows Security or your antivirus, restart Spotify, and reopen Clubify. The VB-CABLE fallback always works.

**Audio is too quiet or too loud**
The tap is pre-mixer, so use Spotify's own volume or the output device volume. Auto level adapts slowly by design; use input trim for manual gain and output gain for the final level, or disable auto level.

**Clicks, dropouts, or stuttering**
Raise the safety buffer, close CPU-heavy applications, or choose a different output device. With the tap, 32–48 ms is a good starting point.

**I can't find the Clubify window**
The app starts in the tray. Left-click the tray icon, near the clock.

**Spotify sounds gritty, dull, or distorted**
Set Spotify's volume to 100% and control loudness in Clubify, set Spotify normalization to *Normal* or off, and disable Spotify's equalizer. If the tap falls back to process loopback, follow [Best quality with Spotify Lossless](#best-quality-with-spotify-lossless).

## Best quality with Spotify Lossless

<details>
<summary>Click to expand the audiophile setup</summary>

The tap captures Spotify's render stream at its native rate (often 44.1 kHz) and resamples to Clubify's output rate, so matching Windows device rates is optional. For the VB-CABLE fallback (and for the shortest possible path), matching rates still helps:

1. Set Spotify to **Lossless**, volume **100%**, normalization **Normal** or off, and disable its equalizer.
2. Open Windows **Settings → System → Sound**.
3. If you use the VB-CABLE fallback, set **CABLE Input** (the Spotify output) to the same rate as your headphones, for example **24-bit, 44100 Hz**.
4. Set the headphones/speakers device to a rate you like; 44.1 kHz is the shortest path, 48 kHz is also fine with the tap.
5. Disable audio enhancements on the output device.
6. Start Clubify; the UI shows the engine rate and the capture feed (`f32`).
7. For a bit-transparent check, select **Clean** or bypass; auto level is not applied while effects are off.

With the tap, Spotify's stream stays in float32 through the DSP; Clubify only resamples when the tap rate differs from the output rate (for example 44.1 kHz to 48 kHz).

</details>

## Known limitations

- Windows x64 only for the supported capture path.
- The Spotify tap injects a small DLL into the local Spotify process. Antivirus/EDR may block it, Spotify updates may break it, and the DLL stays loaded until Spotify restarts (so updates may ask you to restart Spotify). The process-loopback fallback with a virtual cable remains available.
- The tap captures before Windows per-app and device volume; use Spotify's own volume or Clubify's output device volume.
- Spotify is detected by process name, not the Spotify Web API. No login or account access is involved.
- There is a small delay (tens of milliseconds) between Spotify and what you hear, so Clubify is not suited for watching video.
- Spotify's normalized loudness is applied before capture. Clubify cannot recover peaks removed by Spotify's *Loud* limiter, so use *Normal* or off for lossless listening.
- The tap starts with a short (~0.6 s) measurement silence while it determines Spotify's render rate.
- Clubify is unofficial and not affiliated with Spotify. The tap only processes local playback and does not access accounts, the service, or DRM; modifying the desktop client in memory may conflict with Spotify's terms and can break after updates.

## Development

Building Clubify, the architecture, configuration, API, release process, and developer troubleshooting live in **[CONTRIBUTING.md](CONTRIBUTING.md)**.

```powershell
npm install
npm run build:capture
npm run ui:build
npm run engine
```

Open http://127.0.0.1:8787 to control the engine from the browser.

## Third-party components

- [loopback-capture](https://github.com/WerdoxDev/loopback-capture) — MIT, vendored fork under `vendor/loopback-capture`; adds float32 capture, an explicit sample rate, `SRC_DEFAULT_QUALITY`, silence-preserving delivery, the Spotify tap injector/reader, and adaptive render-rate resampling.
- [spotify-tap](https://github.com/tall1on/spotify-tap) — MIT, separate project synced into `vendor/spotify-tap`; in-process Spotify render tap and shared-memory ABI.
- [windows-rs](https://github.com/microsoft/windows-rs) — MIT/Apache-2.0, Windows API bindings used by the capture addon and tap.
- [audify](https://github.com/almoghamdani/audify) — MIT, RtAudio/WASAPI output and Opus bindings.
- [node-addon-api](https://github.com/nodejs/node-addon-api) — MIT, compiled into audify's native addon.
- [RtAudio](https://github.com/thestk/rtaudio) — MIT, compiled into audify's native addon.
- [Opus](https://opus-codec.org) — BSD-3-Clause, compiled into audify's native addon.
- [Tauri](https://tauri.app) — Apache-2.0/MIT.
- Node.js runtime (MIT) is bundled in production builds.

## License

Clubify is free software: you can redistribute it and/or modify it under the terms of the [GNU General Public License v3.0](LICENSE) (**GPL-3.0**). Copyright (C) 2026 Luke Grandke.

This program is distributed in the hope that it will be useful, but **WITHOUT ANY WARRANTY**; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the [LICENSE](LICENSE) file for the full terms.

Source code: <https://github.com/tall1on/clubify>

The app includes a **Licenses & third-party notices** panel with the project license and the full texts of bundled dependencies. It is generated from the installed npm tree and the Cargo dependency graph by `npm run licenses:generate`, which also runs before every UI or desktop build.
