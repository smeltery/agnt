// FILE: providers/claude/transport.js
// Purpose: Spawn-based transport for the Claude Code CLI. Plumbs stdin/stdout
//          between the bridge and `claude` running in stream-json mode.
// Layer: provider plugin (claude)
// Exports: createClaudeTransport
// Depends on: child_process, ./detect
//
// LIMITATIONS — read before extending this:
//   The bridge speaks Codex JSON-RPC over its transport (`turn/start`,
//   `thread/read`, `applicationRequest`, ...). Claude Code's stream-json
//   protocol is different: stdin lines are `{type:"user",message:{...}}` and
//   stdout lines are `{type:"system"|"assistant"|"user"|"result", ...}`.
//   This transport plumbs raw lines in both directions and does NOT translate
//   between schemas. Until a Codex<->stream-json shim is added (separate
//   followup), the iOS app will not understand Claude's events. Use this
//   transport for development of that shim.

const { spawn } = require("child_process");
const { detectClaudeBinary } = require("./detect");

const DEFAULT_ARGS = ["--output-format", "stream-json", "--input-format", "stream-json", "--verbose"];

function createClaudeTransport({
  env = process.env,
  spawnImpl = spawn,
  binPath = "",
  extraArgs = [],
} = {}) {
  const resolvedBin = binPath || detectClaudeBinary({ env });
  if (!resolvedBin) {
    throw new Error(
      "[agnt] claude provider: `claude` CLI not found. "
      + "Install via `npm install -g @anthropic-ai/claude-code` or set CLAUDE_CLI_PATH."
    );
  }

  const args = [...DEFAULT_ARGS, ...extraArgs];
  const description = `\`claude ${args.join(" ")}\``;

  let child = null;
  let stdoutBuffer = "";
  let stderrBuffer = "";
  let didRequestShutdown = false;
  let didReportError = false;
  const listeners = createListenerBag();

  spawnChild();

  return {
    mode: "spawn",
    describe() {
      return description;
    },
    send(message) {
      if (!child?.stdin?.writable || child.stdin.destroyed || child.stdin.writableEnded) {
        return;
      }
      child.stdin.write(message.endsWith("\n") ? message : `${message}\n`);
    },
    onMessage(handler) {
      listeners.onMessage = handler;
    },
    onClose(handler) {
      listeners.onClose = handler;
    },
    onError(handler) {
      listeners.onError = handler;
    },
    onStarted(handler) {
      listeners.onStarted = handler;
    },
    shutdown() {
      didRequestShutdown = true;
      shutdownChild(child);
    },
  };

  function spawnChild() {
    stdoutBuffer = "";
    stderrBuffer = "";
    child = spawnImpl(resolvedBin, args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    child.on("spawn", () => {
      listeners.emitStarted({ mode: "spawn", launchDescription: description });
    });

    child.on("error", (error) => {
      if (didRequestShutdown) return;
      didReportError = true;
      listeners.emitError(error);
    });

    child.on("close", (code, signal) => {
      if (!didRequestShutdown && !didReportError && code !== 0) {
        didReportError = true;
        listeners.emitError(createClaudeCloseError({
          code,
          signal,
          stderrBuffer,
          description,
        }));
        return;
      }
      listeners.emitClose(code, signal);
    });

    child.stdin.on("error", (error) => {
      if (didRequestShutdown && isIgnorableStdinShutdownError(error)) return;
      if (isIgnorableStdinShutdownError(error)) return;
      didReportError = true;
      listeners.emitError(error);
    });

    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString("utf8");
      let newlineIndex;
      while ((newlineIndex = stdoutBuffer.indexOf("\n")) !== -1) {
        const line = stdoutBuffer.slice(0, newlineIndex);
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        if (line.length > 0) {
          listeners.emitMessage(line);
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stderrBuffer = (stderrBuffer + text).slice(-4096);
      // Surface stderr line-by-line so launch failures and warnings are visible.
      for (const line of text.split(/\r?\n/)) {
        if (line.length > 0) {
          console.error(`[agnt][claude] ${line}`);
        }
      }
    });
  }
}

function shutdownChild(child) {
  if (!child || child.exitCode !== null) return;
  try {
    child.stdin?.end();
  } catch {
    // Best-effort.
  }
  try {
    child.kill("SIGTERM");
  } catch {
    // Best-effort.
  }
}

function createClaudeCloseError({ code, signal, stderrBuffer, description }) {
  const tail = (stderrBuffer || "").trim().split("\n").slice(-5).join("\n");
  const reason = signal ? `signal ${signal}` : `code ${code}`;
  const message = `claude exited (${reason}) running ${description}`;
  const error = new Error(tail ? `${message}: ${tail}` : message);
  error.code = code;
  error.signal = signal;
  return error;
}

function isIgnorableStdinShutdownError(error) {
  if (!error) return false;
  return error.code === "EPIPE" || error.code === "ERR_STREAM_DESTROYED";
}

function createListenerBag() {
  return {
    onMessage: null,
    onClose: null,
    onError: null,
    onStarted: null,
    emitMessage(line) {
      try { this.onMessage?.(line); } catch (e) { console.error("[agnt][claude] onMessage handler threw:", e); }
    },
    emitClose(code, signal) {
      try { this.onClose?.({ code, signal }); } catch (e) { console.error("[agnt][claude] onClose handler threw:", e); }
    },
    emitError(error) {
      try { this.onError?.(error); } catch (e) { console.error("[agnt][claude] onError handler threw:", e); }
    },
    emitStarted(info) {
      try { this.onStarted?.(info); } catch (e) { console.error("[agnt][claude] onStarted handler threw:", e); }
    },
  };
}

module.exports = {
  createClaudeTransport,
};
