import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const resources = join(root, "src-tauri", "resources");
const engine = join(resources, "engine");
const modules = ["loopback-capture", "audify", "bindings", "file-uri-to-path", "ws"];

if (!existsSync(join(root, "dist", "index.js"))) {
  console.error("dist/index.js is missing. Run `npm run build` first.");
  process.exit(1);
}

rmSync(resources, { recursive: true, force: true });
mkdirSync(join(engine, "node_modules"), { recursive: true });

copyFileSync(process.execPath, join(resources, "node.exe"));
cpSync(join(root, "dist"), join(engine, "dist"), { recursive: true });
writeFileSync(
  join(engine, "package.json"),
  JSON.stringify({ name: "clubify-engine", private: true, type: "module" }, null, 2),
);

for (const name of modules) {
  const source = join(root, "node_modules", name);
  if (!existsSync(source)) {
    console.error(`Missing runtime module: ${name}`);
    process.exit(1);
  }
  cpSync(source, join(engine, "node_modules", name), { recursive: true });
}

const nodeLicense = join(dirname(process.execPath), "LICENSE");
const licenseTarget = join(resources, "NODE-LICENSE");
if (existsSync(nodeLicense)) {
  copyFileSync(nodeLicense, licenseTarget);
} else {
  writeFileSync(
    licenseTarget,
    `Node.js is licensed for use as follows:

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
THE SOFTWARE.
`,
  );
}

console.log(`Packaged Node ${process.version} and the Clubify engine into src-tauri/resources.`);
