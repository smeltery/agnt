// Small in-memory cache for workspace-local images surfaced through
// `workspace/readImage`. Keyed by `${cwd}::${path}` so the same path under
// two different threads (which may have different workspace roots) doesn't
// clobber. Caches the data URL plus the file's byteLength + mtimeMs so
// subsequent fetches can pass the bridge's notModified hints and avoid
// re-shipping bytes.
//
// We don't persist this — workspace files mutate often, and stale data
// across reloads would be confusing. The bridge always re-validates anyway,
// so a fresh start just costs a round-trip the first time each image is
// rendered.

import { create } from "zustand";
import {
  readWorkspaceImage,
  workspaceImageToDataUrl,
  type WorkspaceImageRequest,
} from "../protocol/workspace-image";
import type { JsonRpcClient } from "../protocol/jsonrpc-client";

interface CacheEntry {
  dataUrl: string;
  byteLength: number;
  mtimeMs?: number;
}

interface State {
  /** path → cached entry (or "loading" / "error" sentinel). */
  byKey: Record<string, CacheEntry | "loading" | { error: string }>;
  ensure(rpc: JsonRpcClient, request: WorkspaceImageRequest): Promise<CacheEntry | null>;
  reset(): void;
}

const inflight = new Map<string, Promise<CacheEntry | null>>();

function makeKey(cwd: string, path: string): string {
  return `${cwd}::${path}`;
}

export const useWorkspaceImageCache = create<State>((set, get) => ({
  byKey: {},
  async ensure(rpc, request) {
    const key = makeKey(request.cwd, request.path);
    const existing = get().byKey[key];
    if (existing && existing !== "loading" && !("error" in existing)) {
      // Probe the bridge with the cached metadata; if it returns notModified
      // we hand back the same entry. This keeps the data URL stable across
      // re-renders without spending bandwidth.
      const inflightProbe = inflight.get(key);
      if (inflightProbe) return inflightProbe;
      const probe = (async (): Promise<CacheEntry | null> => {
        try {
          const result = await readWorkspaceImage(rpc, {
            ...request,
            ifByteLength: existing.byteLength,
            ifMtimeMs: existing.mtimeMs,
          });
          if (result.notModified) return existing;
          const dataUrl = workspaceImageToDataUrl(result);
          if (!dataUrl) return existing;
          const next: CacheEntry = { dataUrl, byteLength: result.byteLength, mtimeMs: result.mtimeMs };
          set({ byKey: { ...get().byKey, [key]: next } });
          return next;
        } catch (error) {
          // Probe failure: keep the existing cached entry rather than dropping
          // it — the next render will retry the probe.
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
    const pending = (async (): Promise<CacheEntry | null> => {
      try {
        const result = await readWorkspaceImage(rpc, request);
        const dataUrl = workspaceImageToDataUrl(result);
        if (!dataUrl) {
          set({ byKey: { ...get().byKey, [key]: { error: "no_data" } } });
          return null;
        }
        const entry: CacheEntry = { dataUrl, byteLength: result.byteLength, mtimeMs: result.mtimeMs };
        set({ byKey: { ...get().byKey, [key]: entry } });
        return entry;
      } catch (error) {
        const message =
          (error as { userMessage?: string; message?: string })?.userMessage
          ?? (error as Error)?.message
          ?? "workspace/readImage failed";
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

export function selectImageState(cwd: string, path: string) {
  return (state: State): CacheEntry | "loading" | { error: string } | null => {
    const entry = state.byKey[makeKey(cwd, path)];
    return entry ?? null;
  };
}

export function __resetWorkspaceImageCacheForTests(): void {
  inflight.clear();
  useWorkspaceImageCache.setState({ byKey: {} });
}
