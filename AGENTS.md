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

- Export `StartTap()` and the `spotify-tap` shared-memory ABI: mapping `Local\SpotifyTap_<pid>_v1`, magic `SPTP` (`0x50545053`), header layout, and heartbeat protocol.
- The Clubify reader/injector is `vendor/loopback-capture/src/tap.rs`.
- The tap DLL is copied to a content-addressed `%LOCALAPPDATA%\Clubify\tap\<hash>` path before injection, so the packaged DLL stays replaceable.

Do not replace the vendored copy with a symlink; other developers and CI need a normal in-repo copy. The prebuilt `vendor/loopback-capture/build/Release/clubify_spotify_tap.dll` is tracked so normal builds do not require the external repo. `spotify-tap` is MIT-licensed; Clubify itself remains GPL-3.0.
