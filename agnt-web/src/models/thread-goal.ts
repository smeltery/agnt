export type ThreadGoalStatus =
  | "active"
  | "paused"
  | "completed"
  | "failed"
  | "blocked"
  | "usageLimited"
  | "budgetLimited";

export interface ThreadGoal {
  threadId: string;
  objective: string;
  status: ThreadGoalStatus;
  tokenBudget?: number;
  tokenUsage?: number;
  createdAt?: number;
  updatedAt?: number;
}

const STATUS_VALUES = new Set<ThreadGoalStatus>([
  "active",
  "paused",
  "completed",
  "failed",
  "blocked",
  "usageLimited",
  "budgetLimited",
]);

export function decodeThreadGoal(raw: unknown, fallbackThreadId?: string): ThreadGoal | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const threadId = readString(obj.threadId) ?? readString(obj.thread_id) ?? fallbackThreadId;
  const objective = readString(obj.objective);
  const status = normalizeGoalStatus(readString(obj.status));
  if (!threadId || !objective || !status) return null;
  return {
    threadId,
    objective,
    status,
    tokenBudget: readFiniteNumber(obj.tokenBudget ?? obj.token_budget),
    tokenUsage: readFiniteNumber(obj.tokenUsage ?? obj.token_usage),
    createdAt: readTimestamp(obj.createdAt ?? obj.created_at),
    updatedAt: readTimestamp(obj.updatedAt ?? obj.updated_at),
  };
}

export function decodeThreadGoalEnvelope(raw: unknown, fallbackThreadId?: string): ThreadGoal | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  return decodeThreadGoal(obj.goal ?? raw, fallbackThreadId);
}

export function normalizeGoalStatus(raw: string | undefined): ThreadGoalStatus | null {
  if (!raw) return null;
  const compact = raw.replace(/[_\s-]+/g, "").toLowerCase();
  const aliases: Record<string, ThreadGoalStatus> = {
    active: "active",
    running: "active",
    inprogress: "active",
    paused: "paused",
    completed: "completed",
    complete: "completed",
    done: "completed",
    failed: "failed",
    error: "failed",
    blocked: "blocked",
    usagelimited: "usageLimited",
    budgetlimited: "budgetLimited",
  };
  const normalized = aliases[compact];
  return normalized && STATUS_VALUES.has(normalized) ? normalized : null;
}

export function threadGoalNeedsAttention(goal: ThreadGoal): boolean {
  return goal.status === "blocked" || goal.status === "usageLimited" || goal.status === "budgetLimited";
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value;
}

function readTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
