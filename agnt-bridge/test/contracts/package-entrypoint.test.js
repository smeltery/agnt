const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const bridgeRoot = path.resolve(__dirname, "../..");

test("package entrypoint exposes bridge lifecycle helpers", () => {
  const agnt = require("../../src");

  for (const name of ["startBridge", "openLastActiveThread", "watchThreadRollout"]) {
    assert.equal(typeof agnt[name], "function", `missing export: ${name}`);
  }
});

test("package bin entries are executable", () => {
  const packageJson = require("../../package.json");

  for (const [command, relativePath] of Object.entries(packageJson.bin || {})) {
    const absolutePath = path.join(bridgeRoot, relativePath);
    const mode = fs.statSync(absolutePath).mode;
    assert.equal(
      (mode & 0o111) !== 0,
      true,
      `${command} bin must be executable: ${relativePath}`,
    );
  }
});
