const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");

test("iOS async answers recover safely from failures before and after delivery", {
  skip: process.platform !== "darwin" ? "requires the macOS Swift compiler" : false,
  timeout: 60000,
}, (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agnt-swift-async-input-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const mobile = path.resolve(__dirname, "../../../../AgntMobile/AgntMobile");
  const sources = ["Core/Models/JSONValue.swift", "Core/Models/RPCMessage.swift",
    "Models/AsyncInput/CodexAsyncUserInput.swift", "Models/AsyncInput/CodexAsyncUserInputProjection.swift"]
    .map((file) => path.join(mobile, file));
  const binary = path.join(directory, "async-input");
  execFileSync("xcrun", ["swiftc", "-default-isolation", "MainActor", "-module-cache-path", path.join(directory, "cache"),
    "-parse-as-library", ...sources,
    path.join(mobile, "Services/CodexService/CodexServiceError.swift"),
    path.join(mobile, "Services/CodexService/AsyncInput/CodexService+AsyncUserInput.swift"),
    path.join(mobile, "Services/CodexService/AsyncInput/CodexService+AsyncAnswerVerification.swift"),
    path.join(__dirname, "../fixtures/async-user-input.swift"), "-o", binary], { timeout: 45000 });
  const output = execFileSync(binary, { encoding: "utf8", timeout: 10000 });
  assert.match(output, /async answer recovery checks passed/);
});
