// FILE: handlers/terminal-handler.js
// Purpose: Owns local-PTY shell sessions exposed to the web client over the
//          encrypted JSON-RPC channel. The phone clients (iOS/Android) run an
//          on-device SSH terminal directly; the browser cannot, so it asks the
//          bridge to spawn a shell on the host where the bridge runs.
// Layer: Bridge handler
// Exports: createTerminalHandler
// Depends on: node-pty, handler-utils, sendApplicationResponse (from bridge.js)
//
// Security: gated behind the `enableWebTerminal` bridge preference (default
// off). Once enabled, any paired client can run arbitrary commands as the
// bridge user — same authority as `agnt up` itself, which already has shell
// access via provider tool calls. The gate is opt-in because raw shell
// bypasses the per-command approval flow opencode/Cursor enforce.

const { createJsonRpcRequestHandler } = require("./handler-utils");

const DEFAULT_TERMINAL_ID = "term-1";
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const MAX_BUFFER_BYTES = 200_000;

/**
 * @param {object} opts
 * @param {() => boolean} opts.isEnabled
 *   Returns whether the web-terminal preference is on. Read-on-each-request
 *   so flipping the toggle takes effect without restarting the bridge.
 * @param {(rawMessage: string) => void} opts.sendApplicationResponse
 *   Bridge function for pushing JSON-RPC notifications/responses back to the
 *   client through the secure transport.
 * @param {{ spawn: (file: string, args: string[], opts: object) => any }} [opts.ptyImpl]
 *   Override for tests. Defaults to `require("node-pty")`.
 * @param {string} [opts.shellPath]   Override for tests. Defaults to user's $SHELL or /bin/bash.
 * @param {() => string} [opts.cwdProvider]  Default cwd. Falls back to process.cwd().
 * @param {string} [opts.logPrefix]
 */
function createTerminalHandler({
  isEnabled,
  sendApplicationResponse,
  ptyImpl,
  shellPath,
  cwdProvider,
  logPrefix = "[agnt]",
}) {
  if (typeof isEnabled !== "function") {
    throw new TypeError("createTerminalHandler: isEnabled must be a function");
  }
  if (typeof sendApplicationResponse !== "function") {
    throw new TypeError(
      "createTerminalHandler: sendApplicationResponse must be a function"
    );
  }

  const sessions = new Map(); // terminalId -> { instanceId, pty, status, buffer, cols, rows, cwd }

  function lazyPty() {
    if (ptyImpl) return ptyImpl;
    try {
      // eslint-disable-next-line global-require
      return require("node-pty");
    } catch (error) {
      throw terminalError(
        "terminal_unavailable",
        `Terminal feature requires node-pty: ${error.message}`
      );
    }
  }

  function defaultShell() {
    if (shellPath) return shellPath;
    return process.env.SHELL || (process.platform === "win32" ? "powershell.exe" : "/bin/bash");
  }

  function defaultCwd() {
    try {
      const candidate = (cwdProvider && cwdProvider()) || process.env.HOME || process.cwd();
      return candidate || process.cwd();
    } catch {
      return process.cwd();
    }
  }

  // ─── RPC dispatch ────────────────────────────────────────

  const handleTerminalRequest = createJsonRpcRequestHandler({
    match: (method) => typeof method === "string" && method.startsWith("terminal/"),
    dispatch: async (method, params) => {
      ensureEnabled();
      switch (method) {
        case "terminal/open":
          return openTerminal(params);
        case "terminal/write":
          return writeTerminal(params);
        case "terminal/resize":
          return resizeTerminal(params);
        case "terminal/clear":
          return clearTerminal(params);
        case "terminal/close":
          return closeTerminal(params);
        case "terminal/snapshot":
          return snapshotTerminal(params);
        default:
          throw terminalError(
            "unknown_terminal_method",
            `Unknown terminal method: ${method}`
          );
      }
    },
    defaultErrorCode: "terminal_failed",
    defaultErrorMessage: "Terminal request failed.",
    onError: (error) => {
      console.error(`${logPrefix} terminal request failed: ${error?.message || error}`);
    },
  });

  function ensureEnabled() {
    if (!isEnabled()) {
      throw terminalError(
        "terminal_disabled",
        "The web terminal is disabled. Enable it from the bridge preferences."
      );
    }
  }

  function openTerminal(params = {}) {
    const terminalId = readTerminalId(params);
    const cols = readCols(params);
    const rows = readRows(params);
    const cwd = readString(params.cwd) || defaultCwd();
    const env = sanitizeEnv(process.env);

    closeSession(terminalId);

    const pty = lazyPty();
    const child = pty.spawn(defaultShell(), [], {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env,
    });

    const instanceId = randomInstanceId();
    const session = {
      instanceId,
      pty: child,
      status: "running",
      buffer: Buffer.alloc(0),
      cols,
      rows,
      cwd,
      errorMessage: null,
    };
    sessions.set(terminalId, session);

    child.onData((data) => {
      const bytes = Buffer.from(data, "utf8");
      appendBuffer(session, bytes);
      pushNotification("terminal/output", {
        terminalId,
        instanceId,
        dataBase64: bytes.toString("base64"),
      });
    });

    child.onExit(({ exitCode, signal }) => {
      // Only mark exit if this is still the current instance.
      const current = sessions.get(terminalId);
      if (!current || current.instanceId !== instanceId) return;
      current.status = "exited";
      current.errorMessage = signal ? `Killed by signal ${signal}` : null;
      pushNotification("terminal/exited", {
        terminalId,
        instanceId,
        exitCode: typeof exitCode === "number" ? exitCode : null,
        signal: signal || null,
      });
    });

    return snapshotResponse(terminalId, session);
  }

  function writeTerminal(params = {}) {
    const terminalId = readTerminalId(params);
    const session = requireRunning(terminalId);
    const dataBase64 = readString(params.dataBase64) || readString(params.data_base64);
    let bytes;
    if (dataBase64) {
      try {
        bytes = Buffer.from(dataBase64, "base64");
      } catch {
        throw terminalError("invalid_terminal_input", "dataBase64 must be valid base64.");
      }
    } else if (typeof params.data === "string") {
      bytes = Buffer.from(params.data, "utf8");
    } else {
      throw terminalError(
        "invalid_terminal_input",
        "terminal/write requires `dataBase64` or `data`."
      );
    }
    if (bytes.length === 0) return { ok: true };
    session.pty.write(bytes.toString("utf8"));
    return { ok: true };
  }

  function resizeTerminal(params = {}) {
    const terminalId = readTerminalId(params);
    const session = sessions.get(terminalId);
    if (!session) return { ok: true };
    const cols = readCols(params);
    const rows = readRows(params);
    session.cols = cols;
    session.rows = rows;
    if (session.status === "running") {
      try {
        session.pty.resize(cols, rows);
      } catch (error) {
        throw terminalError("terminal_resize_failed", error?.message || "resize failed");
      }
    }
    return { ok: true };
  }

  function clearTerminal(params = {}) {
    const terminalId = readTerminalId(params);
    const session = sessions.get(terminalId);
    if (session) session.buffer = Buffer.alloc(0);
    return { ok: true };
  }

  function closeTerminal(params = {}) {
    const terminalId = readTerminalId(params);
    closeSession(terminalId);
    return { ok: true };
  }

  function snapshotTerminal(params = {}) {
    const terminalId = readTerminalId(params);
    const session = sessions.get(terminalId);
    if (!session) {
      return idleSnapshot(terminalId);
    }
    return snapshotResponse(terminalId, session);
  }

  function closeSession(terminalId) {
    const session = sessions.get(terminalId);
    if (!session) return;
    sessions.delete(terminalId);
    try {
      session.pty.kill();
    } catch {
      // already dead
    }
    session.status = "closed";
  }

  function snapshotResponse(terminalId, session) {
    return {
      terminalId,
      instanceId: session.instanceId,
      status: session.status,
      cols: session.cols,
      rows: session.rows,
      cwd: session.cwd,
      historyBase64: session.buffer.toString("base64"),
      errorMessage: session.errorMessage,
      resizeSupported: true,
    };
  }

  function idleSnapshot(terminalId) {
    return {
      terminalId,
      instanceId: null,
      status: "idle",
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      cwd: defaultCwd(),
      historyBase64: "",
      errorMessage: null,
      resizeSupported: true,
    };
  }

  function pushNotification(method, params) {
    sendApplicationResponse(JSON.stringify({ method, params }));
  }

  function requireRunning(terminalId) {
    const session = sessions.get(terminalId);
    if (!session) {
      throw terminalError("terminal_not_running", "Terminal session is not running.");
    }
    if (session.status !== "running") {
      throw terminalError("terminal_not_running", "Terminal session has exited.");
    }
    return session;
  }

  function shutdown() {
    for (const terminalId of Array.from(sessions.keys())) {
      closeSession(terminalId);
    }
  }

  return {
    handleTerminalRequest,
    shutdown,
    /** @internal — exposed for tests */
    _sessions: sessions,
  };
}

// ─── Helpers ─────────────────────────────────────────────────

function appendBuffer(session, bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) return;
  const combined =
    session.buffer.length + bytes.length <= MAX_BUFFER_BYTES
      ? Buffer.concat([session.buffer, bytes])
      : Buffer.concat([session.buffer, bytes]).subarray(-MAX_BUFFER_BYTES);
  session.buffer = combined;
}

function readTerminalId(params) {
  return readString(params?.terminalId) || readString(params?.terminal_id) || DEFAULT_TERMINAL_ID;
}

function readCols(params) {
  const raw = Number(params?.cols);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_COLS;
  return Math.min(500, Math.max(1, Math.floor(raw)));
}

function readRows(params) {
  const raw = Number(params?.rows);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_ROWS;
  return Math.min(500, Math.max(1, Math.floor(raw)));
}

function readString(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}

// Reduce env exposure to what an interactive shell typically needs. Keeps
// secrets like AGNT_RELAY_TOKEN out of the spawned shell unless the user
// has explicitly forwarded them.
function sanitizeEnv(env) {
  const out = {};
  const safeKeys = new Set([
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "PATH",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    "TZ",
    "EDITOR",
    "VISUAL",
    "PAGER",
    "PWD",
    "TMPDIR",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "XDG_RUNTIME_DIR",
    "COLORTERM",
  ]);
  for (const key of safeKeys) {
    if (env[key] !== undefined) out[key] = env[key];
  }
  out.TERM = out.TERM || "xterm-256color";
  return out;
}

function randomInstanceId() {
  return `inst-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function terminalError(code, message) {
  const error = new Error(message);
  error.errorCode = code;
  error.userMessage = message;
  return error;
}

module.exports = { createTerminalHandler };
