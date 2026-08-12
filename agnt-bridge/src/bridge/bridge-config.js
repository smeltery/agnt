// FILE: bridge-config.js
// Purpose: Provider-agnostic bridge runtime configuration. Resolves the relay
//          URL, push service, refresher debounce, keep-awake, and provider id
//          from env vars + persisted daemon state + private defaults.
// Layer: CLI helper
// Exports: readBridgeConfig
// Depends on: fs, path, ./daemon-state

const fs = require("fs");
const path = require("path");
const { readDaemonConfig } = require("../daemon-state");

const DEFAULT_DEBOUNCE_MS = 1200;
const DEFAULT_DESKTOP_IPC_SNAPSHOT_DEBOUNCE_MS = 75;

function readBridgeConfig({
  env = process.env,
  platform = process.platform,
  runtimeRoot = path.resolve(__dirname, ".."),
  fsImpl = fs,
} = {}) {
  const daemonConfig = readDaemonConfig({ env, fsImpl }) || {};
  const privateDefaults = readPrivatePackageDefaults({ runtimeRoot, fsImpl });
  const sourceCheckout = isSourceCheckout(runtimeRoot, fsImpl);
  const defaultRelayUrl = sourceCheckout
    ? ""
    : privateDefaults.relayUrl;
  const explicitRelayUrl = readFirstDefinedEnv(
    ["AGNT_RELAY"],
    "",
    env
  );
  const relayUrl = readFirstDefinedEnv(
    ["AGNT_RELAY"],
    defaultRelayUrl,
    env
  );
  const defaultPushServiceUrl = sourceCheckout || explicitRelayUrl
    ? ""
    : privateDefaults.pushServiceUrl;
  const codexEndpoint = readFirstDefinedEnv(
    ["AGNT_AGENT_ENDPOINT", "AGNT_CODEX_ENDPOINT"],
    "",
    env
  );
  const refreshCommand = readFirstDefinedEnv(
    ["AGNT_REFRESH_COMMAND"],
    "",
    env
  );
  const explicitRefreshEnabled = readOptionalBooleanEnv(["AGNT_REFRESH_ENABLED"], env);
  const explicitDesktopAutoFollowEnabled = readOptionalBooleanEnv(["AGNT_DESKTOP_AUTO_FOLLOW"], env);
  const explicitKeepMacAwakeEnabled = readOptionalBooleanEnv(["AGNT_KEEP_MAC_AWAKE"], env);
  const persistedRefreshEnabled = typeof daemonConfig.refreshEnabled === "boolean"
    ? daemonConfig.refreshEnabled
    : null;
  const persistedKeepMacAwakeEnabled = typeof daemonConfig.keepMacAwakeEnabled === "boolean"
    ? daemonConfig.keepMacAwakeEnabled
    : null;
  // Desktop refresh is opt-in, but once enabled in preferences the persisted
  // choice must survive daemon restarts unless the env explicitly overrides it.
  const defaultRefreshEnabled = persistedRefreshEnabled == null ? false : persistedRefreshEnabled;
  // Desktop IPC live sync has no separate opt-out in agnt (it is inherent to
  // running the local app-server rather than a remote endpoint), so the
  // "liveSync enabled" term collapses to "we own the local Codex runtime".
  const defaultDesktopAutoFollowEnabled = platform === "darwin" && !codexEndpoint;
  return {
    relayUrl,
    pushServiceUrl: readFirstDefinedEnv(
      ["AGNT_PUSH_SERVICE_URL"],
      defaultPushServiceUrl,
      env
    ),
    pushPreviewMaxChars: parseIntegerEnv(
      readFirstDefinedEnv(["AGNT_PUSH_PREVIEW_MAX_CHARS"], "160", env),
      160
    ),
    refreshEnabled: explicitRefreshEnabled == null
      ? defaultRefreshEnabled
      : explicitRefreshEnabled,
    refreshDebounceMs: parseIntegerEnv(
      readFirstDefinedEnv(["AGNT_REFRESH_DEBOUNCE_MS"], String(DEFAULT_DEBOUNCE_MS), env),
      DEFAULT_DEBOUNCE_MS
    ),
    desktopAutoFollowEnabled: explicitDesktopAutoFollowEnabled == null
      ? defaultDesktopAutoFollowEnabled
      : explicitDesktopAutoFollowEnabled,
    keepMacAwakeEnabled: explicitKeepMacAwakeEnabled == null
      ? (persistedKeepMacAwakeEnabled == null ? false : persistedKeepMacAwakeEnabled)
      : explicitKeepMacAwakeEnabled,
    codexEndpoint,
    desktopIpcSocketPath: readFirstDefinedEnv(["AGNT_DESKTOP_IPC_SOCKET"], "", env),
    desktopIpcSnapshotDebounceMs: parseIntegerEnv(
      readFirstDefinedEnv(
        ["AGNT_DESKTOP_IPC_SNAPSHOT_DEBOUNCE_MS"],
        String(DEFAULT_DESKTOP_IPC_SNAPSHOT_DEBOUNCE_MS),
        env
      ),
      DEFAULT_DESKTOP_IPC_SNAPSHOT_DEBOUNCE_MS
    ),
    refreshCommand,
    providerId: typeof daemonConfig.providerId === "string" ? daemonConfig.providerId : "",
  };
}

function readPrivatePackageDefaults({ runtimeRoot, fsImpl }) {
  const defaultsPath = path.join(runtimeRoot, "src", "private-defaults.json");
  if (!fsImpl.existsSync(defaultsPath)) {
    return { relayUrl: "", pushServiceUrl: "" };
  }

  try {
    const parsed = safeParseJSON(fsImpl.readFileSync(defaultsPath, "utf8"));
    return {
      relayUrl: readString(parsed?.relayUrl) || "",
      pushServiceUrl: readString(parsed?.pushServiceUrl) || "",
    };
  } catch {
    return { relayUrl: "", pushServiceUrl: "" };
  }
}

function isSourceCheckout(runtimeRoot, fsImpl) {
  const repoRoot = path.resolve(runtimeRoot, "..");
  return path.basename(runtimeRoot) === "agnt-bridge"
    && fsImpl.existsSync(path.join(repoRoot, ".git"));
}

function readFirstDefinedEnv(keys, fallback, env = process.env) {
  for (const key of keys) {
    const value = env[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }
  return fallback;
}

function readOptionalBooleanEnv(keys, env = process.env) {
  for (const key of keys) {
    const value = env[key];
    if (typeof value === "string" && value.trim() !== "") {
      return parseBooleanEnv(value.trim());
    }
  }
  return null;
}

function parseBooleanEnv(value) {
  const normalized = String(value).trim().toLowerCase();
  return normalized !== "false" && normalized !== "0" && normalized !== "no";
}

function parseIntegerEnv(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function safeParseJSON(value) {
  try { return JSON.parse(value); } catch { return null; }
}

function readString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

module.exports = {
  readBridgeConfig,
};
