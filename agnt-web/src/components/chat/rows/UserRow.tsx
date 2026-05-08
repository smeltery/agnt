import type { CodexMessage } from "../../../models";
import { useLightboxStore } from "../../../state/lightbox-store";

export function UserRow({ message }: { message: CodexMessage }) {
  const showLightbox = useLightboxStore((state) => state.show);
  const className =
    "agnt-row agnt-row-user" +
    (message.deliveryState === "pending" ? " agnt-row-pending" : message.deliveryState === "failed" ? " agnt-row-failed" : "");
  return (
    <div className={className} title={new Date(message.createdAt).toLocaleString()}>
      <div className="agnt-row-bubble">
        {message.attachments && message.attachments.length > 0 && (
          <div className="agnt-row-attachments">
            {message.attachments.map((attachment) => (
              <button
                key={attachment.id}
                type="button"
                className="agnt-row-attachment-button"
                onClick={() =>
                  showLightbox({
                    src: attachment.payloadDataUrl,
                    alt: attachment.fileName,
                    caption: attachment.fileName,
                  })
                }
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
    </div>
  );
}
