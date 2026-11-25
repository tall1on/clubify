import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tapRoot = join(root, "vendor", "spotify-tap");
const builder = join(tapRoot, "scripts", "build-native.mjs");
const built = join(tapRoot, "dist", "spotify_tap.dll");
const destination = join(
  root,
  "vendor",
  "loopback-capture",
  "build",
  "Release",
  "clubify_spotify_tap.dll",
);

if (!existsSync(builder)) {
  console.error("Missing vendor/spotify-tap. Sync it from the separate spotify-tap repo.");
  process.exit(1);
}
execFileSync(process.execPath, [builder], { cwd: tapRoot, stdio: "inherit" });
if (!existsSync(built)) {
  console.error(`spotify-tap build did not produce ${built}`);
  process.exit(1);
}
mkdirSync(dirname(destination), { recursive: true });
copyFileSync(built, destination);
console.log(`Copied ${built} -> ${destination}`);
