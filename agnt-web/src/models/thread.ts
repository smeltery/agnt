// CodexThread equivalent. Server may send keys in either camelCase or snake_case;
// `normalizeThread` is the single point that maps both into the canonical shape.

export type ThreadSyncState = "live" | "archivedLocal";

export interface CodexThread {
  id: string;
  title?: string;
  name?: string;
  preview?: string;
  createdAt?: number;
  updatedAt?: number;
  cwd?: string;
  forkedFromThreadId?: string;
  parentThreadId?: string;
  agentId?: string;
  agentNickname?: string;
  agentRole?: string;
  model?: string;
  modelProvider?: string;
  syncState: ThreadSyncState;
}

type RawThread = Record<string, unknown>;

export function normalizeThread(raw: RawThread, defaults: { syncState?: ThreadSyncState } = {}): CodexThread | null {
  const id = stringField(raw, "id", "threadId");
  if (!id) return null;
  return {
    id,
    title: stringField(raw, "title"),
    name: stringField(raw, "name"),
    preview: stringField(raw, "preview"),
    createdAt: dateField(raw, "createdAt", "created_at"),
    updatedAt: dateField(raw, "updatedAt", "updated_at"),
    cwd: stringField(raw, "cwd", "current_working_directory", "working_directory"),
    forkedFromThreadId: stringField(raw, "forkedFromThreadId", "forked_from_thread_id"),
    parentThreadId: stringField(raw, "parentThreadId", "parent_thread_id"),
    agentId: stringField(raw, "agentId", "agent_id"),
    agentNickname: stringField(raw, "agentNickname", "agent_nickname"),
    agentRole: stringField(raw, "agentRole", "agent_role"),
    model: stringField(raw, "model"),
    modelProvider: stringField(raw, "modelProvider", "model_provider"),
    syncState: defaults.syncState ?? "live",
  };
}

function stringField(raw: RawThread, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function dateField(raw: RawThread, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}
