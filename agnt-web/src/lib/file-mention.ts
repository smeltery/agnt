// Helpers for the @-file picker. Wraps the existing `project/searchDirectories`
// RPC (already used by the project picker) and turns the absolute paths it
// returns into cwd-relative paths so the inserted mention is short.
//
// Empty-query path: when the user has just typed `@` with no text yet, we
// still want to surface *something*, so we list the cwd's top entries via
// `project/listDirectory`.

import {
  listDirectory,
  searchDirectories,
  type ProjectDirectoryEntry,
} from "../protocol/project";
import type { JsonRpcClient } from "../protocol/jsonrpc-client";

const SEARCH_LIMIT = 12;

export async function searchFilesForMention(
  rpc: JsonRpcClient,
  cwd: string,
  query: string
): Promise<ProjectDirectoryEntry[]> {
  const trimmed = query.trim();
  if (!trimmed) {
    const listing = await listDirectory(rpc, { path: cwd, limit: SEARCH_LIMIT });
    return listing.entries;
  }
  const result = await searchDirectories(rpc, { path: cwd, query: trimmed, limit: SEARCH_LIMIT, maxDepth: 6 });
  return result.entries;
}

/** Format an absolute path as relative to `cwd` when possible. Falls back to
 *  the absolute path so the inserted mention always points somewhere. */
export function formatMentionPath(absolutePath: string, cwd: string): string {
  if (!cwd) return absolutePath;
  const normalizedCwd = cwd.endsWith("/") ? cwd : cwd + "/";
  if (absolutePath === cwd) return ".";
  if (absolutePath.startsWith(normalizedCwd)) return absolutePath.slice(normalizedCwd.length);
  return absolutePath;
}
