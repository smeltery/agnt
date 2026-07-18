// In-memory cache for workspace-local UTF-8 files surfaced through
// `workspace/readFile`. Keyed by `${cwd}::${path}` so the same relative path in
// two active workspaces does not collide. Cached metadata is sent back to the
// bridge on later reads so unchanged files avoid re-shipping their body.

import { create } from "zustand";
import type { JsonRpcClient } from "../protocol/jsonrpc-client";
import {
  readWorkspaceTextFile,
  type WorkspaceTextFileRequest,
  type WorkspaceTextFileResult,
} from "../protocol/workspace-file";

export interface WorkspaceTextFileEntry {
  path: string;
  fileName: string;
  byteLength: number;
  mtimeMs?: number;
  encoding: "utf8";
  lineCount: number;
  content: string;
}

interface State {
  byKey: Record<string, WorkspaceTextFileEntry | "loading" | { error: string }>;
  ensure(rpc: JsonRpcClient, request: WorkspaceTextFileRequest): Promise<WorkspaceTextFileEntry | null>;
  reset(): void;
}

const inflight = new Map<string, Promise<WorkspaceTextFileEntry | null>>();

function makeKey(cwd: string, path: string): string {
  return `${cwd}::${path}`;
}

function toEntry(result: WorkspaceTextFileResult, fallback?: WorkspaceTextFileEntry): WorkspaceTextFileEntry | null {
  if (result.notModified && fallback) return fallback;
  if (typeof result.content !== "string") return null;
  return {
    path: result.path,
    fileName: result.fileName,
    byteLength: result.byteLength,
    mtimeMs: result.mtimeMs,
    encoding: result.encoding,
    lineCount: result.lineCount ?? countLines(result.content),
    content: result.content,
  };
}

function countLines(content: string): number {
  if (!content) return 0;
  const lines = content.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.length;
}

export const useWorkspaceFileCache = create<State>((set, get) => ({
  byKey: {},
  async ensure(rpc, request) {
    const key = makeKey(request.cwd, request.path);
    const existing = get().byKey[key];
    if (existing && existing !== "loading" && !("error" in existing)) {
      const inflightProbe = inflight.get(key);
      if (inflightProbe) return inflightProbe;
      const probe = (async (): Promise<WorkspaceTextFileEntry | null> => {
        try {
          const result = await readWorkspaceTextFile(rpc, {
            ...request,
            ifByteLength: existing.byteLength,
            ifMtimeMs: existing.mtimeMs,
          });
          const next = toEntry(result, existing) ?? existing;
          if (next !== existing) set({ byKey: { ...get().byKey, [key]: next } });
          return next;
        } catch {
          return existing;
        } finally {
          inflight.delete(key);
        }
      })();
      inflight.set(key, probe);
      return probe;
    }
    if (existing === "loading") return inflight.get(key) ?? null;
    set({ byKey: { ...get().byKey, [key]: "loading" } });
    const pending = (async (): Promise<WorkspaceTextFileEntry | null> => {
      try {
        const result = await readWorkspaceTextFile(rpc, request);
        const entry = toEntry(result);
        if (!entry) {
          set({ byKey: { ...get().byKey, [key]: { error: "No text content returned." } } });
          return null;
        }
        set({ byKey: { ...get().byKey, [key]: entry } });
        return entry;
      } catch (error) {
        const message =
          (error as { userMessage?: string; message?: string })?.userMessage
          ?? (error as Error)?.message
          ?? "workspace/readFile failed";
        set({ byKey: { ...get().byKey, [key]: { error: message } } });
        return null;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, pending);
    return pending;
  },
  reset() {
    inflight.clear();
    set({ byKey: {} });
  },
}));

export function selectWorkspaceFileState(cwd: string, path: string) {
  return (state: State): WorkspaceTextFileEntry | "loading" | { error: string } | null => {
    const entry = state.byKey[makeKey(cwd, path)];
    return entry ?? null;
  };
}

export function __resetWorkspaceFileCacheForTests(): void {
  inflight.clear();
  useWorkspaceFileCache.setState({ byKey: {} });
}
