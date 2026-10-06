// FILE: providers/opencode/transport.js
// Purpose: Spawn-based transport for opencode. Boots `opencode serve`, discovers
//          the assigned port from stdout, consumes the HTTP+SSE event stream
//          from /event, and exposes `httpRequest()` so the protocol shim can
//          POST to the REST endpoints (/session, /session/{id}/message, ...).
// Layer: provider plugin (opencode)
// Exports: createOpencodeTransport
// Depends on: child_process, http, ./detect
//
// Wire format:
//   stdin  : not used (opencode serve does not read JSON from stdin).
//   stdout : informational lines; the server-ready URL is scraped here.
//   /event : Server-Sent Events stream — `data: {...json...}\n\n` per event.
//
// The bridge core speaks Codex JSON-RPC. The Codex<->opencode protocol shim
// lives in providers/opencode/translate.js and uses
// `transport.httpRequest()` to perform REST calls. This transport stays
// mechanical: it owns the child process, the port discovery, the SSE pump,
// and a tiny HTTP client.

const { spawn } = require("child_process");
const http = require("http");
const { detectOpencodeBinary } = require("./detect");

const { createOpencodeEventStream } = require("./event-stream");

const DEFAULT_HOST = "127.0.0.1";

function createOpencodeTransport({
  env = process.env,
  spawnImpl = spawn,
  binPath = "",
  serveArgs = ["serve", "--hostname", DEFAULT_HOST, "--port", "0"],
  httpImpl = http,
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

  // HTTP requests issued before the server has reported its port queue here
  // and replay once `host`/`port` are known.
  const queuedRequests = [];
  let serverReady = false;
  const flushQueuedRequests = () => {
    serverReady = true;
    while (queuedRequests.length > 0) {
      const job = queuedRequests.shift();
      executeHttp(job).then(job.resolve, job.reject);
    }
  };

  spawnChild();

  return {
    mode: "spawn",
    describe() {
      return port ? `${description} (port=${port})` : description;
    },
    send(_message) {
      // opencode receives turns via REST, not stdin. The translator routes
      // outbound JSON-RPC through `httpRequest()` directly; this hook is a
      // no-op so the bridge core's untranslated send() path does not crash.
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
      try { sseRequest?.stop(); } catch { /* best-effort */ }
      shutdownChild(child);
      while (queuedRequests.length > 0) {
        const job = queuedRequests.shift();
        job.reject(new Error("opencode transport shutdown before HTTP request completed"));
      }
    },
    /**
     * Promise-returning HTTP client scoped to the local opencode server.
     * Queues until the server reports ready so the translator can fire
     * `thread/start` POSTs from the moment the bridge connects.
     *
     * @param {"GET"|"POST"|"PUT"|"DELETE"} method
     * @param {string} pathName  — e.g. "/session" or "/session/<id>/message"
     * @param {object|null} body — JSON-serializable body, or null/undefined
     * @returns {Promise<{status:number, json:object|null, raw:string}>}
     */
    httpRequest(method, pathName, body) {
      const job = { method, pathName, body, resolve: null, reject: null };
      const promise = new Promise((resolve, reject) => {
        job.resolve = resolve;
        job.reject = reject;
      });
      if (!serverReady) {
        queuedRequests.push(job);
      } else {
        executeHttp(job).then(job.resolve, job.reject);
      }
      return promise;
    },
    get host() { return host; },
    get port() { return port; },
  };

  function executeHttp({ method, pathName, body }) {
    const payload = body == null ? "" : JSON.stringify(body);
    const headers = { Accept: "application/json" };
    if (payload) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(payload);
    }
    return new Promise((resolve, reject) => {
      const req = httpImpl.request({
        host,
        port,
        method,
        path: pathName,
        headers,
      }, (res) => {
        let chunks = "";
        res.on("data", (chunk) => { chunks += chunk.toString("utf8"); });
        res.on("end", () => {
          let parsed = null;
          if (chunks.length > 0) {
            try { parsed = JSON.parse(chunks); } catch { /* leave raw */ }
          }
          resolve({ status: res.statusCode || 0, json: parsed, raw: chunks });
        });
      });
      req.on("error", (err) => reject(err));
      if (payload) req.write(payload);
      req.end();
    });
  }

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
      sseRequest?.stop();
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
            flushQueuedRequests();
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

  function startEventStream() {
    sseRequest = createOpencodeEventStream({ httpImpl, host, port,
      onMessage: (payload) => listeners.emitMessage(payload) });
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
