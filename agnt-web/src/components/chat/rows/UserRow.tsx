import { formatRelativeWithAbsolute } from "../../../lib/relative-time";
import type { CodexMessage } from "../../../models";
import { useLightboxStore } from "../../../state/lightbox-store";
import { BookmarkButton } from "./BookmarkButton";
import { RowLinkButton } from "./RowLinkButton";

export function UserRow({ message }: { message: CodexMessage }) {
  const showLightbox = useLightboxStore((state) => state.show);
  const className =
    "agnt-row agnt-row-user" +
    (message.deliveryState === "pending" ? " agnt-row-pending" : message.deliveryState === "failed" ? " agnt-row-failed" : "");
  const attachments = message.attachments ?? [];
  // Build the lightbox set once for the row so left/right cycles within
  // this row's attachments — not across the whole chat.
  const lightboxSet = attachments.map((attachment) => ({
    src: attachment.payloadDataUrl,
    alt: attachment.fileName,
    caption: attachment.fileName,
  }));
  return (
    <div className={className} title={formatRelativeWithAbsolute(message.createdAt)}>
      <div className="agnt-row-bubble">
        {attachments.length > 0 && (
          <div className="agnt-row-attachments">
            {attachments.map((attachment, index) => (
              <button
                key={attachment.id}
                type="button"
                className="agnt-row-attachment-button"
                onClick={() => showLightbox(lightboxSet, index)}
                aria-label={`View ${attachment.fileName ?? "attachment"} full size`}
              >
                <img
                  src={attachment.thumbnailDataUrl}
                  alt={attachment.fileName ?? "Attachment"}
                  className="agnt-row-attachment-thumb"
                />
              </button>
            ))}
          </div>
        )}
        {message.text && <span className="agnt-row-user-text">{message.text}</span>}
      </div>
      {message.deliveryState !== "pending" && (
        <div className="agnt-row-actions">
          <BookmarkButton threadId={message.threadId} messageId={message.id} />
          <RowLinkButton threadId={message.threadId} messageId={message.id} />
        </div>
      )}
    </div>
  );
}
