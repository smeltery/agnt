// FILE: providers/codex/desktop-refresher-executor.js
// Purpose: Executes Codex desktop refresh backends.
// Layer: provider plugin (codex)

const { execFile } = require("child_process");
const path = require("path");

const DEFAULT_BUNDLE_ID = "com.openai.codex";
const DEFAULT_APP_PATH = "/Applications/Codex.app";
const REFRESH_SCRIPT_PATH = path.join(__dirname, "scripts", "codex-refresh.applescript");

function executeDesktopRefresh({
  targetUrl,
  refreshExecutor,
  refreshCommand,
  bundleId,
  appPath,
  navigationOnly,
}) {
  if (refreshExecutor) {
    return refreshExecutor(targetUrl || "");
  }

  if (refreshCommand) {
    return execFilePromise("/bin/sh", ["-lc", refreshCommand]);
  }

  return execFilePromise("osascript", [
    REFRESH_SCRIPT_PATH,
    bundleId,
    appPath,
    targetUrl || "",
    navigationOnly ? "0" : "1",
  ]);
}

function execFilePromise(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

module.exports = {
  DEFAULT_APP_PATH,
  DEFAULT_BUNDLE_ID,
  executeDesktopRefresh,
};
