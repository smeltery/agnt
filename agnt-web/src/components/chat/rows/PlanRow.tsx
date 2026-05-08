import type { CodexMessage, PlanStep } from "../../../models";
import { useThreadsStore } from "../../../state/threads-store";
import { MarkdownContent } from "../MarkdownContent";

const STATUS_LABEL: Record<PlanStep["status"], string> = {
  pending: "•",
  in_progress: "▸",
  completed: "✓",
  failed: "✗",
};

export function PlanRow({ message }: { message: CodexMessage }) {
  const plan = message.plan;
  const cwd = useThreadsStore((state) => {
    if (!message.threadId) return undefined;
    return (
      state.threads.find((t) => t.id === message.threadId)?.cwd
      ?? state.archivedThreads.find((t) => t.id === message.threadId)?.cwd
    );
  });
  if (!plan) return null;
  const presentationLabel =
    plan.presentation === "progress"
      ? "Plan"
      : plan.presentation === "resultStreaming"
        ? "Plan · drafting"
        : plan.presentation === "resultReady"
          ? "Plan · ready"
          : "Plan · closed";
  return (
    <div className="agnt-row agnt-row-plan" title={new Date(message.createdAt).toLocaleString()}>
      <div className="agnt-row-tag">{presentationLabel}</div>
      {plan.explanation && <p className="agnt-row-plan-explanation">{plan.explanation}</p>}
      {plan.steps.length > 0 && (
        <ol className="agnt-row-plan-steps">
          {plan.steps.map((step, index) => (
            <li key={index} className={"agnt-row-plan-step agnt-row-plan-step-" + step.status}>
              <span className="agnt-row-plan-step-marker" aria-hidden>
                {STATUS_LABEL[step.status]}
              </span>
              <span className="agnt-row-plan-step-text">{step.step}</span>
            </li>
          ))}
        </ol>
      )}
      {message.text && (
        <div className="agnt-row-plan-text">
          <MarkdownContent text={message.text} cwd={cwd} />
        </div>
      )}
    </div>
  );
}
