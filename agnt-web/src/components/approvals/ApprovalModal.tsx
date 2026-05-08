// Renders the head of the approval queue as a modal. Decline / Accept resolve
// the underlying server-request promise; "Allow for session" is offered for
// command-execution approvals only (matches iOS behavior).

import { type ApprovalRequest, useApprovalsStore } from "../../state/approvals-store";

export function ApprovalModal() {
  const queue = useApprovalsStore((state) => state.queue);
  const decide = useApprovalsStore((state) => state.decide);
  const head = queue[0];
  if (!head) return null;

  return (
    <div className="agnt-modal-backdrop" role="presentation">
      <div className="agnt-modal" role="dialog" aria-modal="true" aria-labelledby="agnt-approval-title">
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
        {queue.length > 1 && (
          <div className="agnt-modal-queue-hint">
            +{queue.length - 1} more pending
          </div>
        )}
      </div>
    </div>
  );
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
