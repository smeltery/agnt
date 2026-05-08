// thread/turns/list cursor walker. Mirrors
// CodexService+ThreadHistoryPagination.swift: send a paginated thread/turns/list
// request, then walk forward as long as the bridge returns a non-empty cursor.

import type { JsonRpcClient } from "../protocol/jsonrpc-client";

export interface ThreadTurnsPage {
  turns: unknown[];
  nextCursor: string | null;
}

export interface FetchTurnsInput {
  rpc: JsonRpcClient;
  threadId: string;
  limit?: number;
  cursor?: string | null;
  sortDirection?: "asc" | "desc";
}

const DEFAULT_LIMIT = 10;

export async function fetchThreadTurnsPage(input: FetchTurnsInput): Promise<ThreadTurnsPage> {
  const params: Record<string, unknown> = {
    threadId: input.threadId,
    limit: input.limit ?? DEFAULT_LIMIT,
    sortDirection: input.sortDirection ?? "desc",
  };
  if (input.cursor) params.cursor = input.cursor;
  const response = await input.rpc.request<RawTurnsListResponse>("thread/turns/list", params);
  const turns = response.data ?? response.items ?? response.turns ?? [];
  return { turns, nextCursor: extractCursor(response) };
}

/** Walk every page until the bridge returns null/empty cursor. */
export async function* iterateThreadTurns(input: Omit<FetchTurnsInput, "cursor">): AsyncIterable<unknown[]> {
  let cursor: string | null = null;
  while (true) {
    const page: ThreadTurnsPage = await fetchThreadTurnsPage({ ...input, cursor });
    if (page.turns.length > 0) yield page.turns;
    if (!page.nextCursor) return;
    cursor = page.nextCursor;
  }
}

function extractCursor(response: RawTurnsListResponse): string | null {
  const candidate = response.nextCursor ?? response.next_cursor ?? null;
  if (typeof candidate !== "string") return null;
  const trimmed = candidate.trim();
  return trimmed.length > 0 ? trimmed : null;
}

interface RawTurnsListResponse {
  data?: unknown[];
  items?: unknown[];
  turns?: unknown[];
  nextCursor?: unknown;
  next_cursor?: unknown;
}
