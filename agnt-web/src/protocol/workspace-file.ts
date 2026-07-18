// `workspace/readFile` wrapper for workspace-local UTF-8 text previews. The
// bridge owns path scoping, size limits, and text/binary validation; the browser
// only asks for read-only content it can render in a modal code viewer.

import type { JsonRpcClient } from "./jsonrpc-client";

export interface WorkspaceTextFileRequest {
  cwd: string;
  path: string;
  /** If set, the bridge returns notModified:true when the file matches. */
  ifByteLength?: number;
  ifMtimeMs?: number;
  includeContent?: boolean;
  metadataOnly?: boolean;
}

export interface WorkspaceTextFileResult {
  path: string;
  fileName: string;
  byteLength: number;
  mtimeMs?: number;
  encoding: "utf8";
  lineCount?: number;
  content?: string;
  /** When set, the cached body the caller already has is still good. */
  notModified?: boolean;
}

export async function readWorkspaceTextFile(
  rpc: JsonRpcClient,
  request: WorkspaceTextFileRequest
): Promise<WorkspaceTextFileResult> {
  return await rpc.request<WorkspaceTextFileResult>("workspace/readFile", {
    cwd: request.cwd,
    path: request.path,
    ifByteLength: request.ifByteLength,
    ifMtimeMs: request.ifMtimeMs,
    includeContent: request.includeContent,
    metadataOnly: request.metadataOnly,
  });
}
