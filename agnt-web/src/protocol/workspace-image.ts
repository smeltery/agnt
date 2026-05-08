// `workspace/readImage` wrapper. Lets the markdown renderer fetch
// workspace-local images that the assistant references (e.g.
// `![screenshot](.tmp/cap.png)`) by routing through the bridge — the browser
// can't read local filesystem paths directly. The bridge enforces a strict
// allowlist (workspace root, Codex generated images, temp screenshots) so
// nothing further afield gets exposed.
//
// We always pass `maxPixelDimension` so the bridge downscales on macOS via
// `sips` rather than shipping multi-megabyte originals over the relay; the
// downscaled preview is plenty for inline rendering and the user can still
// hit the lightbox to see it bigger (the lightbox shows the same data URL
// since we don't have a way to fetch the original separately yet).

import type { JsonRpcClient } from "./jsonrpc-client";

export interface WorkspaceImageRequest {
  cwd: string;
  path: string;
  maxPixelDimension?: number;
  /** If set, the bridge returns notModified:true when the file matches. */
  ifByteLength?: number;
  ifMtimeMs?: number;
}

export interface WorkspaceImageResult {
  path: string;
  fileName: string;
  mimeType: string;
  byteLength: number;
  mtimeMs?: number;
  /** When set, the cached body the caller already has is still good. */
  notModified?: boolean;
  /** Base64-encoded image bytes; absent when notModified or includeData=false. */
  dataBase64?: string;
}

const DEFAULT_PREVIEW_DIMENSION = 1024;

export async function readWorkspaceImage(
  rpc: JsonRpcClient,
  request: WorkspaceImageRequest
): Promise<WorkspaceImageResult> {
  return await rpc.request<WorkspaceImageResult>("workspace/readImage", {
    cwd: request.cwd,
    path: request.path,
    maxPixelDimension: request.maxPixelDimension ?? DEFAULT_PREVIEW_DIMENSION,
    ifByteLength: request.ifByteLength,
    ifMtimeMs: request.ifMtimeMs,
  });
}

/** Builds a data: URL from the bridge's mimeType + dataBase64 fields. */
export function workspaceImageToDataUrl(result: WorkspaceImageResult): string | null {
  if (!result.dataBase64) return null;
  return `data:${result.mimeType};base64,${result.dataBase64}`;
}
