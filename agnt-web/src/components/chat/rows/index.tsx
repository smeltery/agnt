// Single dispatch point. ChatView renders this; the right component for each
// row's kind/role is selected here so the rest of the chat code stays dumb.

import type { CodexMessage } from "../../../models";
import { AssistantRow } from "./AssistantRow";
import { CommandExecutionRow } from "./CommandExecutionRow";
import { FileChangeRow } from "./FileChangeRow";
import { PlanRow } from "./PlanRow";
import { ReasoningRow } from "./ReasoningRow";
import { ToolActivityRow } from "./ToolActivityRow";
import { UserRow } from "./UserRow";

export function MessageRow({ message }: { message: CodexMessage }) {
  if (message.role === "user") return <UserRow message={message} />;
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
}
