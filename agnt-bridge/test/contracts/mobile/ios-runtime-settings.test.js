const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");

test("mobile settings coordinator preserves newer edits and rejects stale acknowledgements", {
  skip: process.platform !== "darwin" ? "requires the macOS Swift compiler" : false,
  timeout: 60_000,
}, (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agnt-runtime-settings-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const mobile = path.resolve(__dirname, "../../../../AgntMobile/AgntMobile");
  const service = path.join(mobile, "Services/CodexService");
  const types = fs.readFileSync(path.join(service, "CodexService+Types.swift"), "utf8");
  const override = types.slice(types.indexOf("struct CodexThreadRuntimeOverride:"), types.indexOf("struct CodexThreadCompletionBanner:"));
  const overridePath = path.join(directory, "RuntimeOverride.swift");
  fs.writeFileSync(overridePath, `import Foundation\n${override}`);
  const binary = path.join(directory, "checks");
  execFileSync("xcrun", ["swiftc", "-parse-as-library",
    path.join(mobile, "Core/Models/JSONValue.swift"), path.join(mobile, "Core/Models/RPCMessage.swift"),
    path.join(mobile, "Models/Runtime/CodexStreamFailure.swift"),
    path.join(mobile, "Models/AsyncInput/CodexAsyncUserInput.swift"),
    path.join(service, "Runtime/CodexModelOption.swift"), path.join(service, "Runtime/CodexReasoningEffortOption.swift"),
    path.join(service, "Runtime/CodexServiceTier.swift"), path.join(service, "Runtime/CodexRuntimeSettings.swift"),
    path.join(service, "Runtime/CodexService+RuntimeSettingsSync.swift"), overridePath,
    path.join(__dirname, "../fixtures/runtime-settings.swift"), "-o", binary,
  ], { timeout: 45_000 });
  assert.match(execFileSync(binary, { encoding: "utf8", timeout: 10_000 }), /race checks passed/);
});
