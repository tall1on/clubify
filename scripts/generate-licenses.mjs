import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = join(root, "ui", "public");
const outputFile = join(outputDirectory, "licenses.json");
const strict = process.argv.includes("--strict");

const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));

const LICENSE_FILE_PATTERN = /^(?:licen[cs]es?|copying|notice)/i;
const ECOSYSTEM_ORDER = { npm: 0, cargo: 1, runtime: 2 };

const texts = new Map();
const packages = new Map();

function normalizeText(value) {
  return value.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trim();
}

function addText(value) {
  const text = normalizeText(value);
  if (!text) return null;
  const id = createHash("sha256").update(text).digest("hex").slice(0, 16);
  texts.set(id, text);
  return id;
}

function addPackage({ name, version, ecosystem, license, homepage, note, licenseTexts }) {
  const key = `${ecosystem}:${name}@${version}`;
  const textIds = licenseTexts.map(addText).filter(Boolean);
  const existing = packages.get(key);
  if (existing) {
    for (const textId of textIds) {
      if (!existing.textIds.includes(textId)) existing.textIds.push(textId);
    }
    return;
  }
  packages.set(key, {
    name,
    version,
    ecosystem,
    license: license || "UNKNOWN",
    homepage: homepage || "",
    ...(note ? { note } : {}),
    textIds,
  });
}

function readLicenseFiles(directory, declaredFile) {
  const paths = [];
  if (declaredFile) {
    const candidate = isAbsolute(declaredFile) ? declaredFile : resolve(directory, declaredFile);
    if (existsSync(candidate)) paths.push(candidate);
  }
  if (paths.length === 0 && existsSync(directory)) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !LICENSE_FILE_PATTERN.test(entry.name)) continue;
      if (/\.spdx$/i.test(entry.name)) continue;
      paths.push(join(directory, entry.name));
    }
  }
  return [...new Set(paths)]
    .sort((left, right) => left.localeCompare(right))
    .map((path) => normalizeText(readFileSync(path, "utf8")))
    .filter(Boolean);
}

function fallbackText(name, version, license) {
  return [
    "No license file was distributed with this package.",
    "",
    `Package: ${name} ${version}`,
    `Declared license: ${license || "unknown"}`,
  ].join("\n");
}

function readOverride(ecosystem, name) {
  return readFirstText([
    join(root, "licenses", "overrides", ecosystem, `${name}.txt`),
    join(root, "licenses", "overrides", ecosystem, `${name}.md`),
  ]);
}

function licenseTextsWithOverride(directory, ecosystem, name, version, license, declaredFile) {
  let licenseTexts = readLicenseFiles(directory, declaredFile);
  let note;
  if (licenseTexts.length === 0) {
    const override = readOverride(ecosystem, name);
    if (override) {
      licenseTexts = [override];
      note =
        "License text sourced from the upstream project because the package did not " +
        "include a license file.";
    }
  }
  return {
    note,
    licenseTexts:
      licenseTexts.length > 0 ? licenseTexts : [fallbackText(name, version, license)],
  };
}

function licenseValue(value) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object" && typeof value.type === "string") return value.type;
  return null;
}

function homepageValue(manifest) {
  const repository = manifest.repository;
  const repositoryUrl =
    typeof repository === "string" ? repository : repository && repository.url;
  const url = manifest.homepage || repositoryUrl || "";
  return String(url)
    .replace(/^git\+/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/^github:/, "https://github.com/")
    .replace(/\.git$/, "");
}

function parentNpmKey(key) {
  const marker = key.lastIndexOf("/node_modules/");
  if (marker !== -1) return key.slice(0, marker);
  return "";
}

function resolveNpmKey(fromKey, name) {
  let base = fromKey;
  for (;;) {
    const key = base ? `${base}/node_modules/${name}` : `node_modules/${name}`;
    if (lock.packages[key]) return key;
    if (!base) return null;
    base = parentNpmKey(base);
  }
}

function collectNpmPackages() {
  if (!existsSync(join(root, "node_modules"))) {
    throw new Error("node_modules is missing. Run `npm install` before generating licenses.");
  }

  const visited = new Set();
  const queue = [{ key: "", entry: lock.packages[""] }];

  while (queue.length > 0) {
    const { key, entry } = queue.shift();
    const dependencies = {
      ...(entry.dependencies ?? {}),
      ...(entry.optionalDependencies ?? {}),
      ...(entry.peerDependencies ?? {}),
    };
    for (const name of Object.keys(dependencies)) {
      if (dependencies[name] === false) continue;
      const dependencyKey = resolveNpmKey(key, name);
      if (!dependencyKey || visited.has(dependencyKey)) continue;
      visited.add(dependencyKey);
      queue.push({ key: dependencyKey, entry: lock.packages[dependencyKey] });
    }
  }

  const result = [];
  for (const key of visited) {
    const directory = join(root, key);
    const manifestPath = join(directory, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const lockEntry = lock.packages[key];
    const name = manifest.name || lockEntry.name || key;
    const version = manifest.version || lockEntry.version || "";
    const license = licenseValue(manifest.license) || licenseValue(lockEntry.license) || "UNKNOWN";
    const { note, licenseTexts } = licenseTextsWithOverride(
      directory,
      "npm",
      name,
      version,
      license,
    );
    result.push({
      name,
      version,
      ecosystem: "npm",
      license,
      homepage: homepageValue(manifest),
      ...(note ? { note } : {}),
      licenseTexts,
    });
  }

  const found = new Set(result.map((entry) => entry.name));
  const missing = Object.keys(packageJson.dependencies ?? {}).filter((name) => !found.has(name));
  if (missing.length > 0) {
    throw new Error(
      `package-lock.json or node_modules is out of date for: ${missing.join(", ")}. ` +
        "Run `npm install` before generating licenses.",
    );
  }
  return result;
}

function cargoTreeKeys(manifestPath) {
  const output = execFileSync(
    "cargo",
    [
      "tree",
      "--manifest-path",
      manifestPath,
      "--target",
      "x86_64-pc-windows-msvc",
      "--edges",
      "normal",
      "--prefix",
      "none",
      "--no-dedupe",
    ],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 128 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const keys = new Set();
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_.-]+) v([^\s]+)/);
    if (match) keys.add(`${match[1]}@${match[2]}`);
  }
  return keys;
}

function readCargoManifest(manifestPath) {
  let metadata;
  let treeKeys;
  try {
    const output = execFileSync(
      "cargo",
      [
        "metadata",
        "--format-version",
        "1",
        "--filter-platform",
        "x86_64-pc-windows-msvc",
        "--manifest-path",
        manifestPath,
      ],
      {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 128 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    metadata = JSON.parse(output);
    treeKeys = cargoTreeKeys(manifestPath);
  } catch (error) {
    return {
      entries: [],
      error: error instanceof Error ? error.message.split("\n")[0] : String(error),
    };
  }

  const rootId = metadata.resolve?.root;
  const entries = [];
  for (const crate of metadata.packages) {
    if (crate.id === rootId) continue;
    if (!treeKeys.has(`${crate.name}@${crate.version}`)) continue;
    const directory = dirname(crate.manifest_path);
    const license = crate.license || "UNKNOWN";
    const declaredFile = crate.license_file
      ? isAbsolute(crate.license_file)
        ? crate.license_file
        : resolve(directory, crate.license_file)
      : undefined;
    const { note, licenseTexts } = licenseTextsWithOverride(
      directory,
      "cargo",
      crate.name,
      crate.version,
      license,
      declaredFile,
    );
    entries.push({
      name: crate.name,
      version: crate.version,
      ecosystem: "cargo",
      license,
      homepage:
        crate.homepage || crate.repository || `https://crates.io/crates/${crate.name}`,
      ...(note ? { note } : {}),
      licenseTexts,
    });
  }
  return { entries, error: null };
}

function readCargoPackages() {
  const manifests = [
    join(root, "src-tauri", "Cargo.toml"),
    join(root, "vendor", "loopback-capture", "Cargo.toml"),
    join(root, "vendor", "spotify-tap", "Cargo.toml"),
  ];
  const entries = [];
  for (const manifestPath of manifests) {
    if (!existsSync(manifestPath)) continue;
    const result = readCargoManifest(manifestPath);
    if (result.error) {
      const label = manifestPath.includes("spotify-tap")
        ? "spotify-tap"
        : manifestPath.includes("loopback-capture")
          ? "loopback-capture"
          : "src-tauri";
      return { entries: [], error: `${label}: ${result.error}` };
    }
    entries.push(...result.entries);
  }
  return { entries, error: null };
}

function readFirstText(paths) {
  for (const path of paths) {
    if (!existsSync(path)) continue;
    const text = normalizeText(readFileSync(path, "utf8"));
    if (text) return text;
  }
  return null;
}

const NODE_FALLBACK_LICENSE = `Node.js is licensed for use as follows:

Copyright Node.js contributors. All rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.`;

function collectRuntimePackages() {
  const entries = [];
  const nodeLicense =
    readFirstText([
      join(root, "src-tauri", "resources", "NODE-LICENSE"),
      join(dirname(process.execPath), "LICENSE"),
    ]) ?? NODE_FALLBACK_LICENSE;
  entries.push({
    name: "Node.js",
    version: process.version.replace(/^v/, ""),
    ecosystem: "runtime",
    license: "MIT",
    homepage: "https://nodejs.org",
    note:
      "Bundled Node.js runtime. The Node.js license is installed with the app as NODE-LICENSE.",
    licenseTexts: [nodeLicense],
  });

  const tapLicense = readFirstText([join(root, "vendor", "spotify-tap", "LICENSE")]);
  if (tapLicense) {
    entries.push({
      name: "spotify-tap",
      version: "0.1.0",
      ecosystem: "runtime",
      license: "MIT",
      homepage: "",
      note:
        "Injected Spotify render tap. Source is maintained in a separate repository and vendored for builds.",
      licenseTexts: [tapLicense],
    });
  }

  return entries;
}

function mergeExistingCargoPackages() {
  if (!existsSync(outputFile)) return 0;
  try {
    const existing = JSON.parse(readFileSync(outputFile, "utf8"));
    const existingTexts = existing.texts ?? {};
    let restored = 0;
    for (const entry of existing.packages ?? []) {
      if (entry.ecosystem !== "cargo") continue;
      for (const textId of entry.textIds ?? []) {
        if (existingTexts[textId]) texts.set(textId, existingTexts[textId]);
      }
      addPackage({ ...entry, licenseTexts: [] });
      const current = packages.get(`cargo:${entry.name}@${entry.version}`);
      if (current) current.textIds = [...(entry.textIds ?? [])];
      restored += 1;
    }
    return restored;
  } catch {
    return 0;
  }
}

function main() {
  const npmEntries = collectNpmPackages();
  const cargo = readCargoPackages();
  let cargoError = cargo.error;
  let cargoEntries = cargo.entries;
  if (cargoError) {
    const restored = mergeExistingCargoPackages();
    if (restored > 0) {
      console.warn(
        `[licenses] cargo metadata unavailable (${cargoError}); kept ${restored} previously generated Rust entries.`,
      );
      cargoError = null;
    } else {
      console.warn(`[licenses] cargo metadata unavailable (${cargoError}); Rust entries skipped.`);
    }
    cargoEntries = [];
  }

  for (const entry of [...npmEntries, ...cargoEntries, ...collectRuntimePackages()]) {
    addPackage(entry);
  }

  const licenseText = normalizeText(readFileSync(join(root, "LICENSE"), "utf8"));
  const copyright =
    licenseText.match(/^Copyright \(c\).+$/im)?.[0] ??
    `Copyright (c) ${new Date().getFullYear()} ${packageJson.author ?? ""}`.trim();

  const sortedPackages = [...packages.values()].sort((left, right) => {
    const ecosystem = ECOSYSTEM_ORDER[left.ecosystem] - ECOSYSTEM_ORDER[right.ecosystem];
    if (ecosystem !== 0) return ecosystem;
    return (
      left.name.localeCompare(right.name) ||
      left.version.localeCompare(right.version, undefined, { numeric: true })
    );
  });

  const output = {
    generator: "scripts/generate-licenses.mjs",
    sources: ["LICENSE", "package.json", "package-lock.json", "Cargo.lock", "licenses/overrides"],
    note:
      "Generated file. Do not edit by hand. Run `npm run licenses:generate` to refresh " +
      "after changing npm or Cargo dependencies.",
    project: {
      name: "Clubify",
      version: packageJson.version,
      license: licenseValue(packageJson.license) ?? "GPL-3.0",
      copyright,
      homepage: homepageValue(packageJson),
      text: licenseText,
    },
    packages: sortedPackages,
    texts: Object.fromEntries([...texts.entries()].sort(([left], [right]) => left.localeCompare(right))),
  };

  const missing = sortedPackages.filter((entry) =>
    entry.textIds.some((id) =>
      texts.get(id)?.startsWith("No license file was distributed with this package."),
    ),
  );
  if (missing.length > 0) {
    const details = missing
      .map((entry) => `  - ${entry.ecosystem}:${entry.name}@${entry.version}`)
      .join("\n");
    const message =
      `[licenses] ${missing.length} package(s) do not include a license text:\n${details}\n` +
      "Add the upstream license text to licenses/overrides/<npm|cargo>/<package>.txt.";
    if (strict) {
      console.error(message);
      process.exit(1);
    }
    console.warn(message);
  }

  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(outputFile, `${JSON.stringify(output, null, 2)}\n`);

  const counts = { npm: 0, cargo: 0, runtime: 0 };
  for (const entry of sortedPackages) counts[entry.ecosystem] += 1;
  const size = readFileSync(outputFile).length;
  console.log(
    `[licenses] generated ${counts.npm} npm, ${counts.cargo} Rust, ${counts.runtime} runtime entries ` +
      `to ui/public/licenses.json (${(size / 1024).toFixed(0)} KiB).`,
  );
}

main();
