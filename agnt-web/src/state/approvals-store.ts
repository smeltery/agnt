// Pending-approval queue. Server-initiated `item/.../requestApproval` JSON-RPC
// requests park a Promise resolver here; the UI dispatches accept/decline/
// acceptForSession to drain it. Multiple approvals can stack across threads —
// we preserve arrival order, dedup on requestId.
//
// Mirrors CodexService+ThreadsTurns.swift's pendingApprovals + approvePending +
// declinePending. Decision payload shape matches: { decision: "accept" |
// "decline" | "acceptForSession" }.

import { create } from "zustand";

export type ApprovalKind = "command" | "fileChange" | "other";

export interface ApprovalRequest {
  id: string; // JSON-RPC request id, stable per request
  kind: ApprovalKind;
  method: string;
  threadId?: string;
  turnId?: string;
  itemId?: string;
  command?: string;
  reason?: string;
  rawParams: Record<string, unknown>;
}

export type ApprovalDecision = "accept" | "decline" | "acceptForSession";

interface PendingResolver {
  request: ApprovalRequest;
  resolve: (decision: ApprovalDecision) => void;
}

interface ApprovalsState {
  queue: ApprovalRequest[];
  enqueue(request: ApprovalRequest, resolve: (decision: ApprovalDecision) => void): void;
  decide(id: string, decision: ApprovalDecision): void;
  clearAll(): void;
}

const resolvers = new Map<string, PendingResolver>();

export const useApprovalsStore = create<ApprovalsState>((set, get) => ({
  queue: [],
  enqueue(request, resolve) {
    resolvers.set(request.id, { request, resolve });
    const queue = get().queue.filter((existing) => existing.id !== request.id);
    set({ queue: [...queue, request] });
  },
  decide(id, decision) {
    const entry = resolvers.get(id);
    if (!entry) return;
    resolvers.delete(id);
    entry.resolve(decision);
    set({ queue: get().queue.filter((approval) => approval.id !== id) });
  },
  clearAll() {
    for (const [, entry] of resolvers) entry.resolve("decline");
    resolvers.clear();
    set({ queue: [] });
  },
}));

/**
 * Bridge-side adapter for the JSON-RPC server-request handler. Returns a Promise
 * that resolves to the JSON-RPC `result` payload once the user decides. The
 * Promise never rejects; closing the connection drains the queue with "decline".
 */
export function buildApprovalServerRequestHandler(): (params: unknown, method: string) => Promise<unknown> {
  return async (params, method) => {
    const request = decodeApprovalRequest(params, method);
    if (!request) {
      // Unknown shape — refuse gracefully by declining.
      return { decision: "decline" };
    }
    const decision = await new Promise<ApprovalDecision>((resolve) => {
      useApprovalsStore.getState().enqueue(request, resolve);
    });
    return { decision };
  };
}

function decodeApprovalRequest(params: unknown, method: string): ApprovalRequest | null {
  if (!params || typeof params !== "object") return null;
  const obj = params as Record<string, unknown>;
  const id = readString(obj, "requestId", "id") ?? crypto.randomUUID();
  return {
    id,
    method,
    kind: kindForMethod(method),
    threadId: readString(obj, "threadId"),
    turnId: readString(obj, "turnId"),
    itemId: readString(obj, "itemId"),
    command: readString(obj, "command"),
    reason: readString(obj, "reason"),
    rawParams: obj,
  };
}

function kindForMethod(method: string): ApprovalKind {
  if (method.includes("commandExecution") || method.includes("command_execution")) return "command";
  if (method.includes("fileChange") || method.includes("file_change")) return "fileChange";
  return "other";
}

function readString(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}
