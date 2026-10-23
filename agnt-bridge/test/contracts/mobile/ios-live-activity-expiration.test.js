const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");

test("iOS Live Activity deadlines expire outcomes and bound quiet runs", {
  skip: process.platform !== "darwin" ? "requires the macOS Swift compiler" : false, timeout: 60000,
}, (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agnt-live-activity-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const mobile = path.resolve(__dirname, "../../../../AgntMobile/AgntMobile");
  const binary = path.join(directory, "history");
  execFileSync("xcrun", ["swiftc", "-module-cache-path", path.join(directory, "cache"), "-parse-as-library",
    path.join(mobile, "Services/LiveActivity/LiveActivityExpiration.swift"),
    path.join(__dirname, "../fixtures/live-activity-expiration.swift"), "-o", binary], { timeout: 45000 });
  assert.match(execFileSync(binary, { encoding: "utf8", timeout: 10000 }), /live activity expiration checks passed/);
});
