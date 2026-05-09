// Renders the head of the approval queue as a modal. Decline / Accept resolve
// the underlying server-request promise; "Allow for session" is offered for
// command-execution approvals only (matches iOS behavior). When more than
// one approval of the same `kind` is queued (typical during agent-heavy
// flows), a small batch row exposes Accept-all-of-this-kind /
// Decline-all-of-this-kind so users don't have to click through 20 dialogs.
//
// Presented as a Sheet in `alert` mode + `closable={false}` because we
// don't want a stray drag, backdrop click, or Esc to silently decline a
// command on the agent's behalf — the user makes an explicit decision.

import { type ApprovalRequest, useApprovalsStore } from "../../state/approvals-store";
import { Sheet } from "../shared/Sheet";

export function ApprovalModal() {
  const queue = useApprovalsStore((state) => state.queue);
  const decide = useApprovalsStore((state) => state.decide);
  const decideAllOfKind = useApprovalsStore((state) => state.decideAllOfKind);
  const head = queue[0];
  if (!head) return null;

  const sameKindCount = queue.filter((entry) => entry.kind === head.kind).length;
  const otherKindCount = queue.length - sameKindCount;

  return (
    <Sheet
      open
      // `closable=false` means onClose only fires from explicit decisions,
      // which we route through `decide` directly below. The handler here is
      // a defensive no-op so the Sheet contract stays satisfied.
      onClose={() => {}}
      ariaLabel={titleFor(head)}
      presentation="alert"
      closable={false}
    >
      <header className="agnt-modal-header">
        <span className="agnt-row-tag">{labelForKind(head)}</span>
        <h2 id="agnt-approval-title">{titleFor(head)}</h2>
      </header>
      <section className="agnt-modal-body">
        {head.command && (
          <pre className="agnt-modal-command">
            <code>{head.command}</code>
          </pre>
        )}
        {head.reason && <p className="agnt-modal-reason">{head.reason}</p>}
        {!head.command && !head.reason && <p className="agnt-modal-reason">No additional context provided.</p>}
      </section>
      <footer className="agnt-modal-footer">
        <button type="button" className="agnt-button-ghost agnt-button-danger" onClick={() => decide(head.id, "decline")}>
          Decline
        </button>
        {head.kind === "command" && (
          <button type="button" className="agnt-button-ghost" onClick={() => decide(head.id, "acceptForSession")}>
            Allow for session
          </button>
        )}
        <button type="button" className="agnt-button-primary" onClick={() => decide(head.id, "accept")}>
          Accept
        </button>
      </footer>
      {sameKindCount > 1 && (
        <div className="agnt-modal-batch-row">
          <span className="agnt-modal-batch-label">
            {sameKindCount - 1} more {batchNoun(head.kind, sameKindCount - 1)} queued
          </span>
          <div className="agnt-modal-batch-actions">
            <button
              type="button"
              className="agnt-button-ghost agnt-button-danger"
              onClick={() => decideAllOfKind(head.kind, "decline")}
              title="Decline every queued approval of this kind"
            >
              Decline all
            </button>
            <button
              type="button"
              className="agnt-button-ghost"
              onClick={() => decideAllOfKind(head.kind, "accept")}
              title="Accept every queued approval of this kind — review carefully"
            >
              Accept all
            </button>
          </div>
        </div>
      )}
      {otherKindCount > 0 && (
        <div className="agnt-modal-queue-hint">
          +{otherKindCount} of a different kind pending
        </div>
      )}
    </Sheet>
  );
}

function batchNoun(kind: ApprovalRequest["kind"], count: number): string {
  if (kind === "command") return count === 1 ? "command" : "commands";
  if (kind === "fileChange") return count === 1 ? "file change" : "file changes";
  return count === 1 ? "approval" : "approvals";
}

function labelForKind(request: ApprovalRequest): string {
  if (request.kind === "command") return "Command approval";
  if (request.kind === "fileChange") return "File change approval";
  return "Approval requested";
}

function titleFor(request: ApprovalRequest): string {
  if (request.kind === "command") return "Run shell command?";
  if (request.kind === "fileChange") return "Apply file change?";
  return "Action approval requested";
}
