// FILE: providers/claude/transport.js
// Purpose: Spawn-based transport for the Claude Code CLI. Plumbs stdin/stdout
//          between the bridge and `claude` running in stream-json mode, with
//          soft-interrupt support that kills the active turn and silently
//          respawns the CLI for the next user message (preserving the same
//          conversation via `--resume <session_id>`).
// Layer: provider plugin (claude)
// Exports: createClaudeTransport
// Depends on: child_process, ./detect
//
// Wire format:
//   stdin  (`claude --print --input-format=stream-json`)
//          : `{type:"user", message:{...}}` lines
//   stdout (`claude --print --output-format=stream-json --include-partial-messages`)
//          : `{type:"system"|"assistant"|"user"|"result"|"stream_event", ...}` lines
//
// Lifecycle notes:
//   - The CLI accepts multiple `{type:"user"}` lines on stdin and emits one
//     `result` per turn while staying alive. EOF on stdin causes a clean exit.
//   - Aborting a turn means killing the child with SIGINT. Respawning is
//     transparent: the next `send()` after a kill spawns a fresh CLI with
//     `--resume <sessionId>` so conversation history is preserved.
//   - Bridge-level shutdown (transport.shutdown()) is the only way to surface
//     a `close` event to the bridge core; auto-respawns are silent.

const { spawn } = require("child_process");
const { detectClaudeBinary } = require("./detect");

// `--print` enables non-interactive mode (the only mode where stream-json IO
//   is actually honored — the help text says so explicitly).
// `--include-partial-messages` emits the per-token `stream_event` frames the
//   shim relies on for incremental UI updates; without it the assistant's text
//   only lands as one consolidated `assistant` snapshot.
// `--verbose` keeps the `system.init` and `result` frames flowing.
const DEFAULT_ARGS = [
  "--print",
  "--input-format", "stream-json",
  "--output-format", "stream-json",
  "--include-partial-messages",
  "--verbose",
];

function createClaudeTransport({
  env = process.env,
  spawnImpl = spawn,
  binPath = "",
  extraArgs = [],
  cwd = process.cwd(),
} = {}) {
  const resolvedBin = binPath || detectClaudeBinary({ env });
  if (!resolvedBin) {
    throw new Error(
      "[agnt] claude provider: `claude` CLI not found. "
      + "Install via `npm install -g @anthropic-ai/claude-code` or set CLAUDE_CLI_PATH."
    );
  }

  const baseArgs = [...DEFAULT_ARGS, ...extraArgs];
  const description = `\`claude ${baseArgs.join(" ")}\``;

  let child = null;
  let stdoutBuffer = "";
  let stderrBuffer = "";
  let didRequestShutdown = false;
  let didReportError = false;
  let didEmitInitialStarted = false;
  /** Last `session_id` learned via translator → setResumeSessionId so respawns continue the same conversation. */
  let resumeSessionId = "";
  /** Turn-level args layered on top of baseArgs (e.g. --model, --permission-mode). */
  let turnArgs = [];
  /** Spawn cwd; updated when the translator reports a new working directory. */
  let activeCwd = cwd;
  const listeners = createListenerBag();

  spawnChild();

  return {
    mode: "spawn",
    describe() {
      return description;
    },
    /** Write a `{type:"user",...}` line; auto-respawns the CLI if it died after an interrupt. */
    send(message) {
      ensureChild();
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
    /**
     * Soft-interrupt: kill the in-flight turn so the next `send()` respawns a
     * fresh CLI with `--resume <session_id>`. Caller (the translator) has
     * already emitted the synthetic turn/failed + turn/completed.
     */
    interruptTurn() {
      if (!child || child.exitCode !== null) return;
      try { child.kill("SIGINT"); } catch { /* best-effort */ }
      // Drop the reference so the next ensureChild() respawns. The 'close'
      // event fires asynchronously; the auto-respawn flag suppresses the
      // bridge-facing close notification.
      child = null;
    },
    /** Translator publishes the latest Claude session_id so respawns continue history. */
    setResumeSessionId(id) {
      if (typeof id === "string" && id) resumeSessionId = id;
    },
    /**
     * Translator publishes per-turn args (e.g. ["--model","sonnet",
     * "--permission-mode","plan"]). If the arg list changes while a child is
     * running, we kill it so the next send() respawns with the new flags.
     * Mid-conversation continuity is preserved by --resume <sessionId>.
     */
    setTurnArgs(args) {
      const next = Array.isArray(args)
        ? args.filter((a) => typeof a === "string" && a.length > 0)
        : [];
      const changed = next.length !== turnArgs.length
        || next.some((a, i) => a !== turnArgs[i]);
      turnArgs = next;
      if (changed && child && child.exitCode === null) {
        try { child.kill("SIGTERM"); } catch { /* best-effort */ }
        child = null;
      }
    },
    /**
     * Translator publishes the working directory derived from thread/start
     * params. Mirrors setTurnArgs: a change while the child is running
     * SIGTERMs it so the next send() respawns with the new cwd. Conversation
     * continuity is preserved by --resume <sessionId>.
     */
    setCwd(nextCwd) {
      if (typeof nextCwd !== "string" || !nextCwd || nextCwd === activeCwd) return;
      activeCwd = nextCwd;
      if (child && child.exitCode === null) {
        try { child.kill("SIGTERM"); } catch { /* best-effort */ }
        child = null;
      }
    },
  };

  function ensureChild() {
    if (child && child.exitCode === null) return;
    spawnChild();
  }

  function buildSpawnArgs() {
    const args = [...baseArgs, ...turnArgs];
    if (resumeSessionId) {
      args.push("--resume", resumeSessionId);
    }
    return args;
  }

  function spawnChild() {
    stdoutBuffer = "";
    stderrBuffer = "";
    const args = buildSpawnArgs();
    const isInitialSpawn = !didEmitInitialStarted;
    child = spawnImpl(resolvedBin, args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      cwd: activeCwd,
    });

    child.on("spawn", () => {
      // Only the very first spawn surfaces a 'started' event to the bridge.
      // Auto-respawns after an interrupt are invisible — the bridge already
      // considers the transport "started".
      if (!didEmitInitialStarted) {
        didEmitInitialStarted = true;
        listeners.emitStarted({ mode: "spawn", launchDescription: description });
      }
    });

    child.on("error", (error) => {
      if (didRequestShutdown) return;
      didReportError = true;
      listeners.emitError(error);
    });

    child.on("close", (code, signal) => {
      // After an interrupt, child was reset to null and the next send()
      // respawns. Suppress the close so the bridge doesn't tear down.
      if (signal === "SIGINT" || signal === "SIGTERM") {
        if (!didRequestShutdown) return;
      }
      // After a normal turn-completion EOF, the CLI may also exit. Don't
      // bubble the close unless shutdown was requested.
      if (!didRequestShutdown && code === 0) return;

      if (!didRequestShutdown && !didReportError && code !== 0) {
        didReportError = true;
        listeners.emitError(createClaudeCloseError({
          code, signal, stderrBuffer, description,
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
      for (const line of text.split(/\r?\n/)) {
        if (line.length > 0) {
          console.error(`[agnt][claude] ${line}`);
        }
      }
    });

    // Mark for the IDE — initial spawn was a fresh boot. The flag is also
    // used to silence subsequent 'started' emissions.
    void isInitialSpawn;
  }
}

function shutdownChild(child) {
  if (!child || child.exitCode !== null) return;
  try { child.stdin?.end(); } catch { /* best-effort */ }
  try { child.kill("SIGTERM"); } catch { /* best-effort */ }
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
  DEFAULT_ARGS,
};
