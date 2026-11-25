const path = require("node:path");
const { run } = require("vue-tsc");

const typescript6 = require.resolve("@typescript/typescript6/package.json");
run(path.join(path.dirname(typescript6), "lib", "tsc.js"));
