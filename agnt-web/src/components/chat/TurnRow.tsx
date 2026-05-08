import type { AssistantStreamRow } from "../../state/threads-store";

export function TurnRow({ row }: { row: AssistantStreamRow }) {
  switch (row.kind) {
    case "user":
      return (
        <div className="agnt-row agnt-row-user">
          <div className="agnt-row-bubble">{row.text}</div>
        </div>
      );
    case "assistant":
      return (
        <div className="agnt-row agnt-row-assistant">
          <div className="agnt-row-bubble">{row.text}</div>
        </div>
      );
    case "reasoning":
      return (
        <div className="agnt-row agnt-row-reasoning">
          <div className="agnt-row-tag">Thinking</div>
          <div className="agnt-row-reasoning-text">{row.text}</div>
        </div>
      );
    case "tool":
      return (
        <div className="agnt-row agnt-row-tool">
          <div className="agnt-row-tag">Tool · {row.name}</div>
          {row.details && <div className="agnt-row-tool-details">{row.details}</div>}
          <div className={"agnt-row-tool-status agnt-row-tool-status-" + row.status}>{row.status}</div>
        </div>
      );
  }
}
