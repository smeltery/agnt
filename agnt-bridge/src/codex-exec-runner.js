// FILE: codex-exec-runner.js
// Purpose: Generic structured-JSON invoker for the Codex CLI. Wraps
//          `codex exec --output-schema <path> -o <out> -` so callers can
//          request a JSON object conforming to a JSON Schema without owning
//          the spawn/timeout/cleanup plumbing themselves.
// Layer: utility — no git knowledge, no closure deps. Reusable by anything
//        that needs a one-shot structured Codex response.
// Exports: runStructuredCodexJson, CODEX_EXEC_TIMEOUT_MS
//
// Why a module: this used to live inside git-handler.js as
// `runStructuredCodexJson` / `spawnCodexExecJson` / `createCodexExecFailure`
// plus four helpers (resolveCodexExecCommands, resolveBundledCodexCommand,
// isLaunchableFile, shouldRetryCodexExecWithNextCommand), ~180 lines mixed
// in with git plumbing. Nothing about the runner is git-specific; lifting
// it makes the next caller obvious (e.g. a future provider that wants
// structured JSON for its own draft features) and keeps git-handler.js
// focused on git.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const CODEX_EXEC_TIMEOUT_MS = 120_000;

/**
 * Invoke `codex exec` with a JSON schema and return the parsed object.
 * Retries the bundled Codex CLI inside Codex.app when the PATH lookup
 * returns ENOENT — useful on macOS where users have the desktop app but
 * not the standalone CLI.
 *
 * @param {object} options
 * @param {string} options.cwd          — working directory passed to `codex exec -C`.
 * @param {string} options.model        — model id passed to `codex exec -m`.
 * @param {string} options.prompt       — prompt body piped on stdin.
 * @param {object} options.schema       — JSON Schema written to a temp file
 *   and handed to Codex via `--output-schema`. Codex emits a JSON object
 *   conforming to the schema or fails.
 * @param {string} [options.codexAppPath]
 *   — absolute path to `Codex.app`. When set and the PATH lookup fails,
 *     the runner falls back to `<app>/Contents/Resources/codex`.
 * @param {boolean} [options.skipGitRepoCheck=false]
 *   — passes `--skip-git-repo-check`. Required for non-git directories
 *     (e.g. thread-title generation from an arbitrary cwd).
 * @param {string|null} [options.sandboxMode=null]
 *   — passes `-s <mode>` (e.g. "read-only"). Omitted when null.
 * @returns {Promise<any>} the parsed JSON object Codex wrote.
 */
async function runStructuredCodexJson({
  cwd,
  model,
  prompt,
  schema,
  codexAppPath,
  skipGitRepoCheck = false,
  sandboxMode = null,
}) {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "agnt-codex-exec-"));
  const schemaPath = path.join(tempDirectory, "schema.json");
  const outputPath = path.join(tempDirectory, "output.json");
  const commands = resolveCodexExecCommands(codexAppPath);

  fs.writeFileSync(schemaPath, JSON.stringify(schema), "utf8");

  try {
    let lastError = null;

    for (const command of commands) {
      try {
        return await spawnCodexExecJson({
          command,
          cwd,
          model,
          prompt,
          schemaPath,
          outputPath,
          skipGitRepoCheck,
          sandboxMode,
        });
      } catch (error) {
        lastError = error;
        if (!shouldRetryCodexExecWithNextCommand(error)) {
          throw error;
        }
      }
    }

    throw lastError || new Error("Codex CLI is not available on this Mac.");
  } finally {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  }
}

// Returns the ordered list of `codex` commands to try. `codex` on PATH wins;
// the bundled CLI inside Codex.app is the macOS-only fallback when PATH
// doesn't resolve. Order matters: PATH first so a homebrew/npm-installed
// `codex` takes precedence over the desktop bundle's older release.
function resolveCodexExecCommands(codexAppPath) {
  const commands = ["codex"];
  const bundledCommand = resolveBundledCodexCommand(codexAppPath);
  if (bundledCommand && !commands.includes(bundledCommand)) {
    commands.push(bundledCommand);
  }
  return commands;
}

function resolveBundledCodexCommand(codexAppPath) {
  const trimmedAppPath = typeof codexAppPath === "string" ? codexAppPath.trim() : "";
  if (!trimmedAppPath) {
    return "";
  }
  const candidate = path.join(trimmedAppPath, "Contents", "Resources", "codex");
  return isLaunchableFile(candidate) ? candidate : "";
}

function isLaunchableFile(candidatePath) {
  try {
    return fs.statSync(candidatePath).isFile();
  } catch {
    return false;
  }
}

// Only retry on ENOENT — anything else is a real failure that the next
// command would hit too.
function shouldRetryCodexExecWithNextCommand(error) {
  return error?.code === "ENOENT";
}

function spawnCodexExecJson({
  command,
  cwd,
  model,
  prompt,
  schemaPath,
  outputPath,
  skipGitRepoCheck = false,
  sandboxMode = null,
}) {
  const args = [
    "exec",
    "--ephemeral",
    "-C",
    cwd,
    "-m",
    model,
  ];
  if (skipGitRepoCheck) {
    args.push("--skip-git-repo-check");
  }
  if (sandboxMode) {
    args.push("-s", sandboxMode);
  }
  args.push("--output-schema", schemaPath, "-o", outputPath, "-");

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, CODEX_EXEC_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.on("close", (code, signal) => {
      clearTimeout(timeout);

      if (timedOut) {
        reject(new Error("Codex CLI timed out while generating the draft."));
        return;
      }

      if (code !== 0) {
        reject(createCodexExecFailure(code, signal, stdout, stderr));
        return;
      }

      try {
        const outputText = fs.readFileSync(outputPath, "utf8").trim();
        if (!outputText) {
          throw new Error("Codex CLI returned an empty structured response.");
        }
        resolve(JSON.parse(outputText));
      } catch (error) {
        reject(error);
      }
    });

    // Linux emits EPIPE on stdin when the child exits before consuming the
    // prompt (e.g. an invalid invocation that exits fast). The real failure
    // is captured by the `close` handler via exit code + stderr; swallow
    // EPIPE here so it doesn't become an uncaughtException.
    child.stdin.on("error", (error) => {
      if (error?.code !== "EPIPE") {
        clearTimeout(timeout);
        reject(error);
      }
    });
    child.stdin.end(prompt);
  });
}

function createCodexExecFailure(code, signal, stdout, stderr) {
  const detail = [stderr, stdout]
    .map((value) => value.trim())
    .filter(Boolean)
    .flatMap((value) => value.split("\n"))
    .map((line) => line.trim())
    .filter(Boolean)
    .pop();

  const suffix = detail ? ` ${detail}` : "";
  const error = new Error(
    signal
      ? `Codex CLI was interrupted while generating the draft.${suffix}`
      : `Codex CLI exited with code ${code} while generating the draft.${suffix}`
  );
  error.code = code;
  error.signal = signal;
  return error;
}

module.exports = {
  CODEX_EXEC_TIMEOUT_MS,
  runStructuredCodexJson,
};
