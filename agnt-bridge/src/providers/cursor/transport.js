// FILE: providers/cursor/transport.js
// Purpose: Spawn-per-turn transport for the Cursor CLI (`cursor-agent`).
//          Unlike Claude/Codex, cursor-agent does not accept JSON-RPC frames
//          on stdin — each turn is a fresh spawn with the prompt as a CLI
//          argument and `--output-format stream-json` for NDJSON output.
// Layer: provider plugin (cursor)
// Exports: createCursorTransport
// Depends on: child_process, ./detect
//
// Wire format:
//   stdin  : nothing (cursor-agent ignores stdin for prompts in --print mode)
//   argv   : `cursor-agent -p "<prompt>" --output-format stream-json --force
//             [--model <id>] [--resume <session_id>] [extra turn args...]`
//   stdout : NDJSON frames — `{type:"system"|"user"|"assistant"|"tool_call"|"result", ...}`
//
// Lifecycle notes:
//   - The translator emits `JSON.stringify({type:"prompt", text:"..."})`
//     instead of a Claude/Codex JSON-RPC frame. This transport unpacks it,
//     then spawns a fresh CLI process with the prompt as argv. Any prior
//     child is SIGTERMed first — cursor-agent has no multi-turn-per-spawn
//     model.
//   - `interruptTurn()` sends SIGINT and drops the child reference; the
//     translator emits the synthetic turn/failed + turn/completed pair.
//   - Bridge-level shutdown (transport.shutdown()) is the only path that
//     surfaces a `close` event; per-turn child exits are silent.

const { spawn } = require("child_process");
const { detectCursorBinary } = require("./detect");

// Static args applied to every turn:
//   `-p` / `--print` — non-interactive, machine-readable mode.
//   `--output-format stream-json` — NDJSON event stream (system/user/assistant/tool_call/result).
//   `--force` — auto-approve tool calls. cursor-agent has no runtime approval
//     channel in headless mode (unlike opencode's SSE permission.asked); the
//     UI gates approvals via TTY prompts. Without --force the CLI blocks.
const DEFAULT_ARGS = [
  "-p",
  "--output-format", "stream-json",
  "--force",
];

function createCursorTransport({
  env = process.env,
  spawnImpl = spawn,
  binPath = "",
  extraArgs = [],
  cwd = process.cwd(),
} = {}) {
  const resolvedBin = binPath || detectCursorBinary({ env });
  if (!resolvedBin) {
    throw new Error(
      "[agnt] cursor provider: `cursor-agent` CLI not found. "
      + "Install via `curl https://cursor.com/install -fsS | bash` or set CURSOR_CLI_PATH."
    );
  }

  const baseArgs = [...DEFAULT_ARGS, ...extraArgs];
  const description = `\`cursor-agent ${baseArgs.join(" ")} <prompt>\``;

  let child = null;
  let stdoutBuffer = "";
  let stderrBuffer = "";
  let didRequestShutdown = false;
  let didReportError = false;
  let didEmitInitialStarted = false;
  /** Last `session_id` learned via translator → setResumeSessionId so subsequent turns resume history. */
  let resumeSessionId = "";
  /** Per-turn provider flags (e.g. ["--model","sonnet-4.5"]) layered onto baseArgs. */
  let turnArgs = [];
  /** Spawn cwd; updated when the translator reports a new working directory. */
  let activeCwd = cwd;
  const listeners = createListenerBag();

  // Surface an immediate `started` so the bridge moves out of "starting" — the
  // CLI is healthy on PATH, even though no child is running yet (lazy spawn
  // happens on first send()).
  setImmediate(() => {
    if (!didEmitInitialStarted) {
      didEmitInitialStarted = true;
      listeners.emitStarted({ mode: "spawn", launchDescription: description });
    }
  });

  return {
    mode: "spawn",
    describe() {
      return description;
    },
    /**
     * Translator publishes `{type:"prompt", text:"..."}` per turn. Spawn a
     * fresh `cursor-agent` with that text as the prompt arg. Any previous
     * child is SIGTERMed first.
     */
    send(message) {
      const parsed = safeParseJson(message);
      const promptText = readString(parsed?.text);
      if (!promptText) {
        // Drop frames the translator did not intend for the CLI (Claude-style
        // `{type:"user", message:{...}}` lines never reach cursor — translator
        // converts them — but be defensive).
        return;
      }
      shutdownChild(child);
      child = null;
      spawnChild(promptText);
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
      // If we already announced started before the bridge subscribed, the
      // setImmediate above will have run silently. Replay defensively so the
      // bridge moves to "connected".
      if (didEmitInitialStarted) {
        try { handler?.({ mode: "spawn", launchDescription: description }); }
        catch (e) { console.error("[agnt][cursor] onStarted replay threw:", e); }
      }
    },
    shutdown() {
      didRequestShutdown = true;
      shutdownChild(child);
    },
    /** Soft-interrupt: SIGINT the active turn and let the translator emit turn/failed. */
    interruptTurn() {
      if (!child || child.exitCode !== null) return;
      try { child.kill("SIGINT"); } catch { /* best-effort */ }
      // Drop the reference. The 'close' handler suppresses bridge-level close
      // notifications when shutdown was not requested.
      child = null;
    },
    /** Translator publishes the latest cursor session_id so the next turn resumes history. */
    setResumeSessionId(id) {
      if (typeof id === "string" && id) resumeSessionId = id;
    },
    /**
     * Translator publishes per-turn args (e.g. ["--model","gpt-5"]). Stored
     * for the next spawn; no need to restart in-flight since cursor spawns
     * fresh each turn anyway.
     */
    setTurnArgs(args) {
      const next = Array.isArray(args)
        ? args.filter((a) => typeof a === "string" && a.length > 0)
        : [];
      turnArgs = next;
    },
    /** Translator publishes the working directory derived from thread/start params. */
    setCwd(nextCwd) {
      if (typeof nextCwd !== "string" || !nextCwd || nextCwd === activeCwd) return;
      activeCwd = nextCwd;
    },
  };

  function buildSpawnArgs(promptText) {
    const args = [...baseArgs, ...turnArgs];
    if (resumeSessionId) {
      args.push("--resume", resumeSessionId);
    }
    // Pass the prompt as the final positional arg. cursor-agent accepts
    // `-p <prompt>` or `--print <prompt>`; -p is already in DEFAULT_ARGS so
    // the prompt is the next positional after the flags it expects.
    args.push(promptText);
    return args;
  }

  function spawnChild(promptText) {
    stdoutBuffer = "";
    stderrBuffer = "";
    const args = buildSpawnArgs(promptText);
    child = spawnImpl(resolvedBin, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      cwd: activeCwd,
    });

    child.on("error", (error) => {
      if (didRequestShutdown) return;
      didReportError = true;
      listeners.emitError(error);
    });

    child.on("close", (code, signal) => {
      // After interruptTurn() the child was reset to null synchronously, but
      // the actual exit fires asynchronously. Suppress to avoid tearing down
      // the bridge while subsequent turns can still spawn.
      if (signal === "SIGINT" || signal === "SIGTERM") {
        if (!didRequestShutdown) return;
      }
      // After a normal turn (`result` frame → child exits 0), don't bubble.
      if (!didRequestShutdown && code === 0) return;

      if (!didRequestShutdown && !didReportError && code !== 0) {
        didReportError = true;
        listeners.emitError(createCursorCloseError({
          code, signal, stderrBuffer, description,
        }));
        return;
      }
      listeners.emitClose(code, signal);
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
          console.error(`[agnt][cursor] ${line}`);
        }
      }
    });
  }
}

function shutdownChild(child) {
  if (!child || child.exitCode !== null) return;
  try { child.kill("SIGTERM"); } catch { /* best-effort */ }
}

function createCursorCloseError({ code, signal, stderrBuffer, description }) {
  const tail = (stderrBuffer || "").trim().split("\n").slice(-5).join("\n");
  const reason = signal ? `signal ${signal}` : `code ${code}`;
  const message = `cursor-agent exited (${reason}) running ${description}`;
  const error = new Error(tail ? `${message}: ${tail}` : message);
  error.code = code;
  error.signal = signal;
  return error;
}

function createListenerBag() {
  return {
    onMessage: null,
    onClose: null,
    onError: null,
    onStarted: null,
    emitMessage(line) {
      try { this.onMessage?.(line); } catch (e) { console.error("[agnt][cursor] onMessage handler threw:", e); }
    },
    emitClose(code, signal) {
      try { this.onClose?.({ code, signal }); } catch (e) { console.error("[agnt][cursor] onClose handler threw:", e); }
    },
    emitError(error) {
      try { this.onError?.(error); } catch (e) { console.error("[agnt][cursor] onError handler threw:", e); }
    },
    emitStarted(info) {
      try { this.onStarted?.(info); } catch (e) { console.error("[agnt][cursor] onStarted handler threw:", e); }
    },
  };
}

function safeParseJson(line) {
  if (typeof line !== "string") return null;
  try { return JSON.parse(line); } catch { return null; }
}

function readString(value) {
  return typeof value === "string" && value ? value : "";
}

module.exports = {
  createCursorTransport,
  DEFAULT_ARGS,
};
