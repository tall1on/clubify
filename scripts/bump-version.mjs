import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = (process.argv[2] ?? "").replace(/^v/, "");

if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("Usage: npm run version:bump -- <version>");
  console.error("Example: npm run version:bump -- 0.2.0");
  process.exit(1);
}

function indentOf(text) {
  const match = text.match(/\n( +)"/);
  return match ? match[1].length : 2;
}

function newlineOf(text) {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function updateJson(relativePath, update) {
  const path = join(root, relativePath);
  const raw = readFileSync(path, "utf8");
  const data = JSON.parse(raw);
  update(data);
  const newline = newlineOf(raw);
  const serialized = JSON.stringify(data, null, indentOf(raw)).replace(/\n/g, newline);
  writeFileSync(path, `${serialized}${newline}`);
  console.log(`updated ${relativePath}`);
}

function updateText(relativePath, replacer) {
  const path = join(root, relativePath);
  const raw = readFileSync(path, "utf8");
  const updated = replacer(raw);
  if (updated === raw) {
    throw new Error(`Could not update the version in ${relativePath}`);
  }
  writeFileSync(path, updated);
  console.log(`updated ${relativePath}`);
}

updateJson("package.json", (data) => {
  data.version = version;
});

updateJson("package-lock.json", (data) => {
  data.version = version;
  if (data.packages?.[""]) {
    data.packages[""].version = version;
  }
});

updateJson("src-tauri/tauri.conf.json", (data) => {
  data.version = version;
});

updateText(
  "src-tauri/Cargo.toml",
  (raw) => raw.replace(/(\[package\][\s\S]*?\nversion\s*=\s*")[^"]+(")/, `$1${version}$2`),
);

updateText(
  "src-tauri/Cargo.lock",
  (raw) => raw.replace(/(\[\[package\]\]\nname = "clubify"\nversion = ")[^"]+(")/, `$1${version}$2`),
);

console.log(`\nClubify version bumped to ${version}.`);
console.log("Commit and push to main to trigger the release workflow.");
