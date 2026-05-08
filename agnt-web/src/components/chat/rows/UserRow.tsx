import type { CodexMessage } from "../../../models";

export function UserRow({ message }: { message: CodexMessage }) {
  const className =
    "agnt-row agnt-row-user" +
    (message.deliveryState === "pending" ? " agnt-row-pending" : message.deliveryState === "failed" ? " agnt-row-failed" : "");
  return (
    <div className={className} title={new Date(message.createdAt).toLocaleString()}>
      <div className="agnt-row-bubble">
        {message.attachments && message.attachments.length > 0 && (
          <div className="agnt-row-attachments">
            {message.attachments.map((attachment) => (
              <img
                key={attachment.id}
                src={attachment.thumbnailDataUrl}
                alt={attachment.fileName ?? "Attachment"}
                className="agnt-row-attachment-thumb"
              />
            ))}
          </div>
        )}
        {message.text && <span className="agnt-row-user-text">{message.text}</span>}
      </div>
    </div>
  );
}
