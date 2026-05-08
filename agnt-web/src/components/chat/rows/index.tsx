// Single dispatch point. ChatView renders this; the right component for each
// row's kind/role is selected here so the rest of the chat code stays dumb.

import { memo } from "react";
import type { CodexMessage } from "../../../models";
import { AssistantRow } from "./AssistantRow";
import { CommandExecutionRow } from "./CommandExecutionRow";
import { FileChangeRow } from "./FileChangeRow";
import { PlanRow } from "./PlanRow";
import { ReasoningRow } from "./ReasoningRow";
import { SystemErrorRow } from "./SystemErrorRow";
import { ToolActivityRow } from "./ToolActivityRow";
import { UserRow } from "./UserRow";

// Wrapped in `React.memo` so a parent re-render (e.g. typing in the
// composer, ticking the throughput pill) doesn't cascade through every
// row. The reducer mutates messages by reference — a row only gets a new
// reference when its actual content changes — so referential equality on
// `message` is exactly the right gate.
export const MessageRow = memo(function MessageRow({ message }: { message: CodexMessage }) {
  if (message.role === "user") return <UserRow message={message} />;
  // Failed-turn marker rows come through as role:system + deliveryState:failed.
  // Surfacing them as a dedicated component keeps the assistant row's hover
  // actions from leaking onto error markers.
  if (message.role === "system" && message.deliveryState === "failed") {
    return <SystemErrorRow message={message} />;
  }
  switch (message.kind) {
    case "thinking":
      return <ReasoningRow message={message} />;
    case "commandExecution":
      return <CommandExecutionRow message={message} />;
    case "fileChange":
      return <FileChangeRow message={message} />;
    case "toolActivity":
      return <ToolActivityRow message={message} />;
    case "plan":
      return <PlanRow message={message} />;
    case "chat":
    default:
      // userInputPrompt + subagentAction still fall through to AssistantRow until
      // Session 4 ships dedicated renderers; their text is the most useful surface.
      return <AssistantRow message={message} />;
  }
});
