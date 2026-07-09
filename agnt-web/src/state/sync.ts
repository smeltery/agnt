// Post-handshake bootstrap. Faithful subset of CodexService+Connection.swift +
// CodexService+Sync.swift. Issues the RPC sequence the iOS app does after
// secure-ready, then returns the snapshot for the connection store to apply.
//
// Provider-specific gates (account/status/read is Codex-only) are honored: any
// RPC that isn't supported simply resolves to undefined here.

import type { JsonRpcClient, JsonRpcRemoteError } from "../protocol/jsonrpc-client";
import { makeLogger } from "../lib/log";
import { type CodexThread, normalizeThread } from "../models/thread";

const log = makeLogger("sync");

export interface InitializeResponse {
  experimentalApi: boolean;
  serverInfo?: { name?: string; version?: string };
}

export interface BootstrapSnapshot {
  initialize: InitializeResponse;
  threads: CodexThread[];
  archivedThreads: CodexThread[];
  models: ModelOption[];
}

export interface ModelOption {
  id: string;
  model?: string;
  name?: string;
  displayName?: string;
  description?: string;
  isDefault?: boolean;
  supportsFastMode?: boolean;
}

export interface BootstrapInputs {
  rpc: JsonRpcClient;
  clientInfo: { name: string; title: string; version: string };
}

export async function runPostHandshakeBootstrap(inputs: BootstrapInputs): Promise<BootstrapSnapshot> {
  const initialize = await runInitialize(inputs);
  inputs.rpc.notify("initialized");
  const [threads, archivedThreads, models] = await Promise.all([
    runThreadList(inputs.rpc, false),
    runThreadList(inputs.rpc, true),
    runModelList(inputs.rpc),
  ]);
  return { initialize, threads, archivedThreads, models };
}

async function runInitialize(inputs: BootstrapInputs): Promise<InitializeResponse> {
  try {
    const result = await inputs.rpc.request<{ capabilities?: { experimentalApi?: boolean }; serverInfo?: InitializeResponse["serverInfo"] }>(
      "initialize",
      {
        clientInfo: inputs.clientInfo,
        capabilities: { experimentalApi: true },
      }
    );
    return {
      experimentalApi: Boolean(result.capabilities?.experimentalApi),
      serverInfo: result.serverInfo,
    };
  } catch (error) {
    if (isMethodNotFound(error)) return { experimentalApi: false };
    throw error;
  }
}

async function runThreadList(rpc: JsonRpcClient, archived: boolean): Promise<CodexThread[]> {
  try {
    const result = await rpc.request<RawThreadListResponse>("thread/list", { limit: 50, archived });
    const raw = result.data ?? result.items ?? result.threads ?? [];
    const syncState = archived ? "archivedLocal" : "live";
    return raw
      .map((t) => normalizeThread(t as Record<string, unknown>, { syncState }))
      .filter((t): t is CodexThread => t !== null);
  } catch (error) {
    if (isMethodNotFound(error)) return [];
    log.warn(`thread/list (archived=${archived}) failed`, error);
    return [];
  }
}

async function runModelList(rpc: JsonRpcClient): Promise<ModelOption[]> {
  try {
    const result = await rpc.request<RawModelListResponse>("model/list", { cursor: null, limit: 50, includeHidden: false });
    const raw = result.items ?? result.data ?? result.models ?? [];
    return raw
      .map((entry) => normalizeModel(entry as Record<string, unknown>))
      .filter((m): m is ModelOption => m !== null);
  } catch (error) {
    if (isMethodNotFound(error)) return [];
    log.warn("model/list failed", error);
    return [];
  }
}

export function normalizeModel(raw: Record<string, unknown>): ModelOption | null {
  const id = readFirstString(raw, ["id", "slug", "model"]);
  if (!id) return null;
  const model = readFirstString(raw, ["model", "slug", "id"]);
  return {
    id,
    model,
    name: readFirstString(raw, ["name"]),
    displayName: readFirstString(raw, ["displayName", "display_name"]),
    description: readFirstString(raw, ["description"]),
    isDefault: readFirstBoolean(raw, ["isDefault", "is_default"]),
    supportsFastMode: modelSupportsFastMode(raw, id, model),
  };
}

export function modelSupportsFastMode(raw: Record<string, unknown>, id = "", model = ""): boolean {
  const explicit = readFirstBoolean(raw, [
    "supportsFastMode",
    "supports_fast_mode",
    "fastMode",
    "fast_mode",
    "fastServiceTier",
    "fast_service_tier",
  ]);
  if (explicit !== undefined) return explicit;
  if (readSpeedTiers(raw).some((tier) => tier.trim().toLowerCase() === "fast")) return true;
  return [id, model].some((value) => STATIC_FAST_MODE_MODELS.has(value.trim().toLowerCase()));
}

const STATIC_FAST_MODE_MODELS = new Set([
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.2-codex",
  "gpt-5.2",
]);

function readFirstString(raw: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function readFirstBoolean(raw: Record<string, unknown>, keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

function readSpeedTiers(raw: Record<string, unknown>): string[] {
  const tiers: string[] = [];
  for (const key of ["additionalSpeedTiers", "additional_speed_tiers"]) {
    const value = raw[key];
    if (!Array.isArray(value)) continue;
    tiers.push(...value.filter((entry): entry is string => typeof entry === "string"));
  }
  return tiers;
}

function isMethodNotFound(error: unknown): boolean {
  // -32601 is the JSON-RPC code for "method not found"; also surfaced when a
  // provider's translator simply doesn't speak the RPC (e.g. opencode + initialize).
  return (error as JsonRpcRemoteError | undefined)?.code === -32601;
}

interface RawThreadListResponse {
  data?: unknown[];
  items?: unknown[];
  threads?: unknown[];
}

interface RawModelListResponse {
  data?: unknown[];
  items?: unknown[];
  models?: unknown[];
}
