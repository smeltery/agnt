import { useMemo, useState } from "react";
import { type ThreadGoal, threadGoalNeedsAttention } from "../../models";
import { useThreadGoalsStore } from "../../state/thread-goals-store";

interface ThreadGoalControlProps {
  threadId: string | null;
}

export function ThreadGoalControl({ threadId }: ThreadGoalControlProps) {
  const goal = useThreadGoalsStore((state) => (threadId ? state.byThread[threadId] : undefined));
  const setThreadGoal = useThreadGoalsStore((state) => state.setGoal);
  const clearThreadGoal = useThreadGoalsStore((state) => state.clear);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [budgetDraft, setBudgetDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const mode = goal ? "edit" : "new";
  const statusLabel = goal ? goalStatusLabel(goal) : "Goal";
  const budgetLabel = useMemo(() => {
    if (!goal?.tokenBudget) return null;
    const remaining = goal.tokenBudget - (goal.tokenUsage ?? 0);
    return `${formatTokenCount(Math.max(remaining, 0))} left`;
  }, [goal]);

  async function submit() {
    if (!threadId || busy) return;
    const objective = draft.trim();
    if (!objective && !goal) return;
    const tokenBudget = parseBudget(budgetDraft);
    setBusy(true);
    const ok = await setThreadGoal({
      threadId,
      objective: objective || undefined,
      tokenBudget,
      status: goal?.status === "paused" ? "active" : undefined,
    });
    setBusy(false);
    if (!ok) return;
    setDraft("");
    setBudgetDraft("");
    setOpen(false);
  }

  async function setStatus(status: ThreadGoal["status"]) {
    if (!threadId || busy) return;
    setBusy(true);
    await setThreadGoal({ threadId, status });
    setBusy(false);
  }

  async function clear() {
    if (!threadId || busy) return;
    setBusy(true);
    const ok = await clearThreadGoal(threadId);
    setBusy(false);
    if (ok) setOpen(false);
  }

  if (!threadId) return null;

  return (
    <div className="agnt-goal-control">
      <button
        type="button"
        className={
          "agnt-goal-pill"
          + (goal ? " agnt-goal-pill-active" : "")
          + (goal && threadGoalNeedsAttention(goal) ? " agnt-goal-pill-attention" : "")
        }
        onClick={() => {
          setDraft(goal?.objective ?? "");
          setBudgetDraft(goal?.tokenBudget ? String(goal.tokenBudget) : "");
          setOpen((current) => !current);
        }}
        aria-expanded={open}
        title={goal?.objective ?? "Set a thread goal"}
      >
        <span className="agnt-goal-dot" />
        <span>{statusLabel}</span>
        {budgetLabel && <span className="agnt-goal-budget">{budgetLabel}</span>}
      </button>
      {open && (
        <div className="agnt-goal-popover" role="dialog" aria-label={goal ? "Edit thread goal" : "Set thread goal"}>
          <label>
            <span>Objective</span>
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Keep working until the goal is done"
              rows={3}
            />
          </label>
          <label>
            <span>Token budget</span>
            <input
              value={budgetDraft}
              onChange={(event) => setBudgetDraft(event.target.value)}
              inputMode="numeric"
              placeholder="Optional"
            />
          </label>
          {goal && (
            <div className="agnt-goal-popover-actions">
              {goal.status === "paused" ? (
                <button type="button" className="agnt-button-ghost" onClick={() => void setStatus("active")} disabled={busy}>
                  Resume
                </button>
              ) : (
                <button type="button" className="agnt-button-ghost" onClick={() => void setStatus("paused")} disabled={busy}>
                  Pause
                </button>
              )}
              <button type="button" className="agnt-button-ghost agnt-button-danger" onClick={() => void clear()} disabled={busy}>
                Clear
              </button>
            </div>
          )}
          <div className="agnt-goal-popover-actions">
            <button type="button" className="agnt-button-ghost" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button type="button" className="agnt-button-primary" onClick={() => void submit()} disabled={busy || (!draft.trim() && mode === "new")}>
              {mode === "new" ? "Start" : "Save"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function goalStatusLabel(goal: ThreadGoal): string {
  switch (goal.status) {
    case "active":
      return "Goal active";
    case "paused":
      return "Goal paused";
    case "completed":
      return "Goal done";
    case "failed":
      return "Goal failed";
    case "blocked":
      return "Goal blocked";
    case "usageLimited":
      return "Goal usage limited";
    case "budgetLimited":
      return "Goal budget limited";
  }
}

function parseBudget(raw: string): number | null | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed.replaceAll(",", ""));
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}
