import type {
  AppConfig,
  AppStatus,
  ProviderBridgeStatus,
  ProviderKeyStatus,
} from "./host-types";

export const STATE_LABELS: Record<string, string> = {
  stopped: "Stopped",
  starting: "Starting...",
  relay_running: "Relay Running",
  local_ready: "Local Ready",
  remote_placeholder_ready: "Remote Placeholder",
  waiting_for_pairing: "Waiting for Pairing",
  connected: "Connected",
  warning: "Warning",
  error: "Error",
};

export const STATE_COLORS: Record<string, string> = {
  stopped: "#9AA4B2",
  starting: "#FFB020",
  relay_running: "#4F8CFF",
  local_ready: "#35C759",
  remote_placeholder_ready: "#FFB020",
  waiting_for_pairing: "#4F8CFF",
  connected: "#35C759",
  warning: "#FFB020",
  error: "#FF5C5C",
};

export const DEFAULT_STATUS: AppStatus = {
  state: "stopped",
  relay_mode: "local",
  relay: "stopped",
  bridge: "stopped",
  network: "--",
  relay_url: "",
  pairing_payload: null,
  pairing_code: null,
  phone_connected: false,
};

export const DEFAULT_CONFIG: AppConfig = {
  relay_mode: "local",
  selected_ip: "",
  relay_port: 9000,
  remote_relay_url: "ws://127.0.0.1:9000",
  auto_start: false,
  auto_restart: false,
  start_minimized: false,
  launch_at_startup: false,
  setup_completed: false,
  requires_entitlement: true,
  free_message_limit: 5,
  relay_path: null,
  bridge_path: null,
  log_level: "info",
  provider_bridge: {
    bind_host: "127.0.0.1",
    port: 8787,
    provider: "deepseek",
    default_model: "deepseek-v4-pro",
  },
};

export const DEFAULT_PROVIDER_BRIDGE_STATUS: ProviderBridgeStatus = {
  running: false,
  bind_host: "127.0.0.1",
  port: 8787,
  base_url: "http://127.0.0.1:8787",
  provider: "deepseek",
};

export const DEFAULT_PROVIDER_KEY_STATUS: ProviderKeyStatus = {
  available: false,
  source: "missing",
  has_stored_key: false,
};
