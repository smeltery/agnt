// FILE: providers/opencode/transport.js
// Purpose: Spawn-based transport for opencode. Boots `opencode serve`, discovers
//          the assigned port from stdout, and consumes the HTTP+SSE event stream
//          from the local server. Send is fire-and-forget HTTP POST.
// Layer: provider plugin (opencode)
// Exports: createOpencodeTransport
// Depends on: child_process, http, ./detect
//
// LIMITATIONS — read before extending this:
//   1. The bridge speaks Codex JSON-RPC over its transport (`turn/start`,
//      `thread/read`, ...). opencode's HTTP API uses REST endpoints
//      (`POST /session`, `POST /session/{id}/message`, `GET /event` SSE).
//      This transport plumbs raw JSON lines via SSE for inbound and emits a
//      clear "send not mapped" error on outbound until a Codex<->REST shim
//      lands (separate followup).
//   2. The exact opencode REST schema is not stable across versions. The
//      version pinning + endpoint discovery work belongs in that shim.
//   3. Port discovery scrapes stdout for "http://...:<port>". Brittle but
//      adequate until opencode publishes an explicit ready-event.

const { spawn } = require("child_process");
const http = require("http");
const { detectOpencodeBinary } = require("./detect");

const DEFAULT_HOST = "127.0.0.1";

function createOpencodeTransport({
  env = process.env,
  spawnImpl = spawn,
  binPath = "",
  serveArgs = ["serve", "--hostname", DEFAULT_HOST, "--port", "0"],
} = {}) {
  const resolvedBin = binPath || detectOpencodeBinary({ env });
  if (!resolvedBin) {
    throw new Error(
      "[agnt] opencode provider: `opencode` CLI not found. "
      + "Install from https://opencode.ai or set OPENCODE_CLI_PATH."
    );
  }

  const description = `\`opencode ${serveArgs.join(" ")}\``;
  let child = null;
  let stdoutBuffer = "";
  let stderrBuffer = "";
  let port = 0;
  let host = DEFAULT_HOST;
  let didRequestShutdown = false;
  let didReportError = false;
  let didEmitStarted = false;
  let sseRequest = null;
  const listeners = createListenerBag();

  spawnChild();

  return {
    mode: "spawn",
    describe() {
      return port ? `${description} (port=${port})` : description;
    },
    send(_message) {
      // TODO: map bridge JSON-RPC -> opencode REST (POST /session/{id}/message).
      listeners.emitError(new Error(
        "[agnt] opencode provider: outbound send is not mapped yet. "
        + "The bridge speaks Codex JSON-RPC; opencode speaks REST. A protocol "
        + "shim is required before send() can be wired."
      ));
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
      try { sseRequest?.destroy(); } catch { /* best-effort */ }
      shutdownChild(child);
    },
  };

  function spawnChild() {
    stdoutBuffer = "";
    stderrBuffer = "";
    child = spawnImpl(resolvedBin, serveArgs, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.on("error", (error) => {
      if (didRequestShutdown) return;
      didReportError = true;
      listeners.emitError(error);
    });

    child.on("close", (code, signal) => {
      if (!didRequestShutdown && !didReportError && code !== 0) {
        didReportError = true;
        listeners.emitError(createCloseError({ code, signal, stderrBuffer, description }));
        return;
      }
      listeners.emitClose(code, signal);
    });

    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString("utf8");
      if (!port) {
        const match = stdoutBuffer.match(/https?:\/\/([^\s:/]+):(\d+)/);
        if (match) {
          host = match[1] || DEFAULT_HOST;
          port = Number(match[2]);
          if (port && !didEmitStarted) {
            didEmitStarted = true;
            listeners.emitStarted({ mode: "spawn", launchDescription: description, host, port });
            startEventStream();
          }
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stderrBuffer = (stderrBuffer + text).slice(-4096);
      for (const line of text.split(/\r?\n/)) {
        if (line.length > 0) {
          console.error(`[agnt][opencode] ${line}`);
        }
      }
    });
  }

  // Subscribes to the SSE event stream once the local server is up.
  function startEventStream() {
    if (!port) return;
    const req = http.get({ host, port, path: "/event" }, (res) => {
      if (res.statusCode !== 200) {
        listeners.emitError(new Error(
          `[agnt] opencode SSE stream failed: HTTP ${res.statusCode} on /event`
        ));
        return;
      }
      let buf = "";
      res.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        let newlineIndex;
        while ((newlineIndex = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, newlineIndex).trim();
          buf = buf.slice(newlineIndex + 1);
          if (!line || line.startsWith(":") || line.startsWith("event:")) continue;
          if (line.startsWith("data:")) {
            const payload = line.slice(5).trim();
            if (payload.length > 0) {
              listeners.emitMessage(payload);
            }
          }
        }
      });
      res.on("close", () => {
        if (!didRequestShutdown) {
          listeners.emitClose(0, null);
        }
      });
    });
    req.on("error", (error) => {
      if (didRequestShutdown) return;
      didReportError = true;
      listeners.emitError(error);
    });
    sseRequest = req;
  }
}

function shutdownChild(child) {
  if (!child || child.exitCode !== null) return;
  try { child.kill("SIGTERM"); } catch { /* best-effort */ }
}

function createCloseError({ code, signal, stderrBuffer, description }) {
  const tail = (stderrBuffer || "").trim().split("\n").slice(-5).join("\n");
  const reason = signal ? `signal ${signal}` : `code ${code}`;
  const message = `opencode exited (${reason}) running ${description}`;
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
      try { this.onMessage?.(line); } catch (e) { console.error("[agnt][opencode] onMessage handler threw:", e); }
    },
    emitClose(code, signal) {
      try { this.onClose?.({ code, signal }); } catch (e) { console.error("[agnt][opencode] onClose handler threw:", e); }
    },
    emitError(error) {
      try { this.onError?.(error); } catch (e) { console.error("[agnt][opencode] onError handler threw:", e); }
    },
    emitStarted(info) {
      try { this.onStarted?.(info); } catch (e) { console.error("[agnt][opencode] onStarted handler threw:", e); }
    },
  };
}

module.exports = {
  createOpencodeTransport,
};
