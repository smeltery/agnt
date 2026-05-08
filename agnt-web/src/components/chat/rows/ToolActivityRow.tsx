import type { CodexMessage } from "../../../models";

export function ToolActivityRow({ message }: { message: CodexMessage }) {
  const status = message.isStreaming ? "running" : "completed";
  return (
    <div className="agnt-row agnt-row-tool">
      <div className="agnt-row-tag">Tool</div>
      {message.text && <div className="agnt-row-tool-details">{message.text}</div>}
      <div className={"agnt-row-tool-status agnt-row-tool-status-" + status}>{status}</div>
    </div>
  );
}
