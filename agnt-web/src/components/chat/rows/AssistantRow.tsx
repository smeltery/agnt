import type { CodexMessage } from "../../../models";
import { MarkdownContent } from "../MarkdownContent";

export function AssistantRow({ message }: { message: CodexMessage }) {
  return (
    <div className={"agnt-row agnt-row-assistant" + (message.isStreaming ? " agnt-row-streaming" : "")}>
      <div className="agnt-row-bubble">
        <MarkdownContent text={message.text} />
        {message.isStreaming && <span className="agnt-cursor-blink" aria-hidden />}
      </div>
    </div>
  );
}
