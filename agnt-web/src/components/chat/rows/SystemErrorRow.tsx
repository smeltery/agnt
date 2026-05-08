import type { CodexMessage } from "../../../models";

export function SystemErrorRow({ message }: { message: CodexMessage }) {
  return (
    <div
      className="agnt-row agnt-row-system-error"
      title={new Date(message.createdAt).toLocaleString()}
    >
      <span className="agnt-row-tag agnt-row-system-error-tag">Turn failed</span>
      <span className="agnt-row-system-error-text">{message.text}</span>
    </div>
  );
}
