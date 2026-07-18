import { useEffect } from "react";
import { formatWorkspaceFileSize, languageForWorkspacePath } from "../../lib/workspace-text-preview";
import { useConnectionStore } from "../../state/connection-store";
import {
  selectWorkspaceFileState,
  useWorkspaceFileCache,
  type WorkspaceTextFileEntry,
} from "../../state/workspace-file-cache";
import { Sheet } from "../shared/Sheet";
import { CodeBlock } from "./CodeBlock";

interface WorkspaceTextFilePreviewProps {
  cwd: string;
  path: string;
  label: string;
  open: boolean;
  onClose(): void;
}

export function WorkspaceTextFilePreview({ cwd, path, label, open, onClose }: WorkspaceTextFilePreviewProps) {
  const connection = useConnectionStore((state) => state.connection);
  const cached = useWorkspaceFileCache(selectWorkspaceFileState(cwd, path));
  const ensure = useWorkspaceFileCache((state) => state.ensure);

  useEffect(() => {
    if (!open || !connection?.rpc) return;
    void ensure(connection.rpc, { cwd, path });
  }, [open, cwd, path, connection, ensure]);

  return (
    <Sheet open={open} onClose={onClose} ariaLabel={`Preview ${label || path}`} maxWidth={980}>
      <div className="agnt-workspace-file-preview">
        {renderHeader(cached, label, path)}
        {renderBody(cached, path)}
      </div>
    </Sheet>
  );
}

function renderHeader(
  cached: WorkspaceTextFileEntry | "loading" | { error: string } | null,
  label: string,
  path: string
) {
  const loaded = cached && typeof cached === "object" && !("error" in cached) ? cached : null;
  const displayName = loaded?.fileName || label || path;
  return (
    <div className="agnt-workspace-file-header">
      <div className="agnt-workspace-file-title" title={path}>{displayName}</div>
      <div className="agnt-workspace-file-meta">
        {loaded
          ? `${formatWorkspaceFileSize(loaded.byteLength)} - ${loaded.lineCount} ${loaded.lineCount === 1 ? "line" : "lines"}`
          : path}
      </div>
    </div>
  );
}

function renderBody(cached: WorkspaceTextFileEntry | "loading" | { error: string } | null, path: string) {
  if (cached && typeof cached === "object" && "error" in cached) {
    return <div className="agnt-workspace-file-error" role="alert">{cached.error}</div>;
  }
  if (cached && typeof cached === "object") {
    const language = languageForWorkspacePath(cached.fileName || path);
    return (
      <div className="agnt-workspace-file-code">
        <CodeBlock language={language} body={cached.content} defaultLineNumbers />
      </div>
    );
  }
  return <div className="agnt-workspace-file-loading" aria-busy>Loading file...</div>;
}
