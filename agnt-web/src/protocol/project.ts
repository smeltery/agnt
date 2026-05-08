// Project folder browser RPCs. Mirrors the surface the bridge exposes via
// project-handler.js: quick-locations seed, directory listing, fuzzy search,
// path validation, and "create new directory" — so users can pick a folder for
// a new thread without the bridge spawning a hosted file picker.

import type { JsonRpcClient } from "./jsonrpc-client";

export interface ProjectQuickLocation {
  id: string;
  label: string;
  path: string;
}

export interface ProjectDirectoryEntry {
  name: string;
  path: string;
  isSymlink?: boolean;
}

export interface ProjectListing {
  path: string;
  parentPath: string | null;
  entries: ProjectDirectoryEntry[];
}

export interface ProjectSearchResult {
  path: string;
  entries: ProjectDirectoryEntry[];
}

export interface ProjectPathValidation {
  path: string;
  exists: boolean;
  isDirectory: boolean;
  isAllowed: boolean;
}

export async function fetchQuickLocations(rpc: JsonRpcClient): Promise<ProjectQuickLocation[]> {
  const result = await rpc.request<{ locations?: unknown[] }>("project/quickLocations", {});
  if (!Array.isArray(result.locations)) return [];
  return result.locations
    .map(decodeQuickLocation)
    .filter((entry): entry is ProjectQuickLocation => entry !== null);
}

export async function listDirectory(
  rpc: JsonRpcClient,
  params: { path?: string; includeHidden?: boolean; limit?: number } = {}
): Promise<ProjectListing> {
  const result = await rpc.request<Record<string, unknown>>("project/listDirectory", params);
  return {
    path: stringField(result, "path") ?? "",
    parentPath: stringField(result, "parentPath") ?? null,
    entries: decodeEntries(result.entries),
  };
}

export async function searchDirectories(
  rpc: JsonRpcClient,
  params: { path: string; query: string; includeHidden?: boolean; limit?: number; maxDepth?: number }
): Promise<ProjectSearchResult> {
  const result = await rpc.request<Record<string, unknown>>("project/searchDirectories", params);
  return {
    path: stringField(result, "path") ?? params.path,
    entries: decodeEntries(result.entries),
  };
}

export async function validateProjectPath(rpc: JsonRpcClient, candidatePath: string): Promise<ProjectPathValidation> {
  const result = await rpc.request<Record<string, unknown>>("project/validatePath", { path: candidatePath });
  return {
    path: stringField(result, "path") ?? candidatePath,
    exists: Boolean(result.exists),
    isDirectory: Boolean(result.isDirectory),
    isAllowed: Boolean(result.isAllowed),
  };
}

export async function createDirectory(
  rpc: JsonRpcClient,
  parentPath: string,
  name: string
): Promise<{ path: string; parentPath: string; name: string }> {
  const result = await rpc.request<Record<string, unknown>>("project/createDirectory", { parentPath, name });
  return {
    path: stringField(result, "path") ?? "",
    parentPath: stringField(result, "parentPath") ?? parentPath,
    name: stringField(result, "name") ?? name,
  };
}

function decodeQuickLocation(raw: unknown): ProjectQuickLocation | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const id = stringField(record, "id");
  const label = stringField(record, "label");
  const path = stringField(record, "path");
  if (!id || !label || !path) return null;
  return { id, label, path };
}

function decodeEntries(raw: unknown): ProjectDirectoryEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const record = entry as Record<string, unknown>;
      const name = stringField(record, "name");
      const path = stringField(record, "path");
      if (!name || !path) return null;
      return { name, path, isSymlink: Boolean(record.isSymlink) } as ProjectDirectoryEntry;
    })
    .filter((entry): entry is ProjectDirectoryEntry => entry !== null);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}
