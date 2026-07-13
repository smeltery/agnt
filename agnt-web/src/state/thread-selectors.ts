import type { CodexMessage, CodexThread } from "../models";
import type { ModelOption } from "./sync";
import type { ReviewTarget, ServiceTier, ThreadsState, TurnFlags } from "./threads-store";

export function selectActiveMessages(state: ThreadsState): CodexMessage[] {
  if (!state.selectedThreadId) return [];
  return state.reducerStates[state.selectedThreadId]?.messages ?? [];
}

export function selectActiveTurnRunning(state: ThreadsState): boolean {
  if (!state.selectedThreadId) return false;
  return Boolean(state.reducerStates[state.selectedThreadId]?.activeTurnId);
}

export function isThreadUnread(thread: CodexThread, lastVisited: Record<string, number>): boolean {
  const updated = thread.updatedAt;
  if (typeof updated !== "number") return false;
  const visited = lastVisited[thread.id];
  if (typeof visited !== "number") return updated > 0;
  return updated > visited;
}

export function effectiveServiceTier(flags: TurnFlags, models: ModelOption[]): ServiceTier | undefined {
  if (flags.serviceTier !== "fast") return undefined;
  const selectedModel = flags.model
    ? models.find((model) => model.id === flags.model || model.model === flags.model)
    : models.find((model) => model.isDefault);
  return selectedModel?.supportsFastMode ? "fast" : undefined;
}

export function buildReviewStartParams(
  threadId: string,
  options: { target?: ReviewTarget; baseBranch?: string } = {}
): Record<string, unknown> | null {
  const target = options.target ?? "uncommittedChanges";
  if (target === "baseBranch") {
    const branch = options.baseBranch?.trim();
    if (!branch) return null;
    return {
      threadId,
      delivery: "inline",
      target: { type: "baseBranch", branch },
    };
  }
  return {
    threadId,
    delivery: "inline",
    target: { type: "uncommittedChanges" },
  };
}

export function reviewPromptText(options: { target?: ReviewTarget; baseBranch?: string } = {}): string {
  if (options.target === "baseBranch") {
    const branch = options.baseBranch?.trim();
    return branch ? `Review against base branch ${branch}` : "Review against base branch";
  }
  return "Review current changes";
}

export function prependSystemPrompt(content: string, systemPrompt: string): string {
  const prompt = systemPrompt.trim();
  if (!prompt) return content;
  if (!content.trim()) return prompt;
  return `${prompt}\n\n${content}`;
}
