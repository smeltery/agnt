export interface LogEntry {
  timestamp: string;
  source: string;
  level: string;
  message: string;
}

export interface NetworkInterface {
  name: string;
  address: string;
  kind: string;
  is_private: boolean;
}

export interface AppStatus {
  state: string;
  relay_mode: string;
  relay: string;
  bridge: string;
  network: string;
  relay_url: string;
  pairing_payload: string | null;
  pairing_code: string | null;
  phone_connected: boolean;
}

export interface DebugInfo {
  cwd: string;
  repo_root: string;
  relay_dir: string;
  relay_server_exists: boolean;
  bridge_dir: string;
  bridge_bin_exists: boolean;
  config_path: string;
  config_exists: boolean;
  node_version: string;
}

export interface UpdateInfo {
  version: string;
  current_version: string;
  date: string | null;
  body: string | null;
}

export interface BundlePackageMetadata {
  name: string | null;
  version: string | null;
}

export interface BundleComponentManifest {
  package: BundlePackageMetadata | null;
  hash: string;
}

export interface BundleManifest {
  schemaVersion: number;
  generatedAt: string;
  relay: BundleComponentManifest;
  bridge: BundleComponentManifest;
}

export interface RuntimeBundleStatus {
  bundled_manifest: BundleManifest | null;
  runtime_manifest: BundleManifest | null;
  runtime_current: boolean;
  refresh_available: boolean;
  refresh_deferred: boolean;
  bundled_path: string;
  runtime_path: string;
  message: string;
}

export interface DiagnosticAction {
  kind: string;
  label: string;
  value: string | null;
}

export interface DiagnosticCheck {
  id: string;
  title: string;
  status: "pass" | "warn" | "fail" | string;
  detail: string;
  action: DiagnosticAction | null;
}

export interface SetupPreset {
  id: string;
  title: string;
  detail: string;
  status: "pass" | "warn" | "fail" | string;
  action: DiagnosticAction | null;
}

export interface DiagnosticsSnapshot {
  generated_at: string;
  summary: string;
  checks: DiagnosticCheck[];
  presets: SetupPreset[];
  recommended_actions: DiagnosticAction[];
  runtime: RuntimeBundleStatus;
  debug: DebugInfo;
}

export type View = "dashboard" | "network" | "logs" | "settings" | "diagnostics";

export interface AppConfig {
  relay_mode: string;
  selected_ip: string;
  relay_port: number;
  remote_relay_url: string;
  auto_start: boolean;
  auto_restart: boolean;
  start_minimized: boolean;
  launch_at_startup: boolean;
  setup_completed: boolean;
  requires_entitlement: boolean;
  free_message_limit: number;
  relay_path: string | null;
  bridge_path: string | null;
  log_level: string;
  provider_bridge: ProviderBridgeConfig;
}

export interface ProviderBridgeConfig {
  bind_host: string;
  port: number;
  provider: string;
  default_model: string;
}

export interface ProviderBridgeStatus {
  running: boolean;
  bind_host: string;
  port: number;
  base_url: string;
  provider: string;
}

export interface ProviderKeyStatus {
  available: boolean;
  source: "environment" | "stored" | "missing" | string;
  has_stored_key: boolean;
}
