import type { CodexMessage } from "../../../models";

export function UserRow({ message }: { message: CodexMessage }) {
  const className =
    "agnt-row agnt-row-user" + (message.deliveryState === "pending" ? " agnt-row-pending" : message.deliveryState === "failed" ? " agnt-row-failed" : "");
  return (
    <div className={className}>
      <div className="agnt-row-bubble">{message.text}</div>
    </div>
  );
}
