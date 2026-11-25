# Agent notes

## Spotify tap (`spotify-tap`)

The canonical tap source lives in the separate repository:

`C:\Users\Luke Grandke\PhpstormProjects\spotify-tap`

Make tap changes there first. Do not maintain a second implementation inside Clubify.

After changing the external repo, sync it into the vendored build copy:

1. Copy the updated source into `vendor/spotify-tap` (at minimum `src/lib.rs`; copy `Cargo.toml`, `Cargo.lock`, and `.cargo/config.toml` too when dependencies or build flags change).
2. Run `npm run build:tap` (or `npm run build:capture`) from the Clubify repo. This builds the vendored copy and copies `spotify_tap.dll` to `vendor/loopback-capture/build/Release/clubify_spotify_tap.dll`.
3. Restart Spotify if you need the newly built DLL loaded; the old injected DLL stays in Spotify until its process exits.

Keep these in sync between the external repo and Clubify:

- Export `StartTap()`/`StopTap()` and the `spotify-tap` shared-memory ABI: mapping `Local\SpotifyTap_<pid>_v1`, magic `SPTP` (`0x50545053`), header layout, and heartbeat protocol.
- Header version 2 lives in the `Local\SpotifyTap_<pid>_v2` mapping and is 128 bytes: the first 64 bytes match version 1, then `seq`/`qpc` (a seqlock used to measure the real render rate) and `dropped_bytes`. The v2 DLL also signals `Local\SpotifyTapEvent_<pid>_v2` on every write; the reader waits on it and only falls back to polling for version 1 headers. `StartTap` returns `20` when an older DLL owns the hook; readers then use that DLL's `_v1` mapping (ring at offset 64) instead of writing a v2 header into a smaller section.
- The Clubify reader/injector is `vendor/loopback-capture/src/tap.rs`; the native WASAPI render output is `vendor/loopback-capture/src/output.rs`.
- The tap DLL is copied to a content-addressed `%LOCALAPPDATA%\Clubify\tap\<hash>` path before injection, so the packaged DLL stays replaceable.

Do not replace the vendored copy with a symlink; other developers and CI need a normal in-repo copy. The prebuilt `vendor/loopback-capture/build/Release/clubify_spotify_tap.dll` is tracked so normal builds do not require the external repo. `spotify-tap` is MIT-licensed; Clubify itself remains GPL-3.0.
