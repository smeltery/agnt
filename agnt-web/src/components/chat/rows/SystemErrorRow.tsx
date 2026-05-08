import type { CodexMessage } from "../../../models";
import { useThreadsStore } from "../../../state/threads-store";

export function SystemErrorRow({ message }: { message: CodexMessage }) {
  const retryFailedTurn = useThreadsStore((state) => state.retryFailedTurn);
  // We need both threadId and turnId to drive a retry. Failed-row metadata is
  // populated by applyTurnFailed, so the missing-id case only matters during
  // hand-rolled fixtures.
  const canRetry = Boolean(message.threadId && message.turnId);
  return (
    <div
      className="agnt-row agnt-row-system-error"
      title={new Date(message.createdAt).toLocaleString()}
    >
      <span className="agnt-row-tag agnt-row-system-error-tag">Turn failed</span>
      <span className="agnt-row-system-error-text">{message.text}</span>
      {canRetry && (
        <button
          type="button"
          className="agnt-row-action agnt-row-system-error-retry"
          onClick={() => void retryFailedTurn(message.threadId, message.turnId!)}
          title="Re-issue the same prompt"
        >
          Retry
        </button>
      )}
    </div>
  );
}
