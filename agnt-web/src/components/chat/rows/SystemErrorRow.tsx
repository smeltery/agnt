import { useState } from "react";
import type { CodexMessage } from "../../../models";
import { useThreadsStore } from "../../../state/threads-store";

export function SystemErrorRow({ message }: { message: CodexMessage }) {
  const retryFailedTurn = useThreadsStore((state) => state.retryFailedTurn);
  const models = useThreadsStore((state) => state.models);
  const currentModel = useThreadsStore((state) => {
    if (!message.threadId) return undefined;
    return state.overridesByThread[message.threadId]?.model ?? state.turnFlags.model;
  });
  // The picker is collapsed by default — most retries don't need a model
  // change, and a stack of inline forms on every error row would be noisy.
  const [showPicker, setShowPicker] = useState(false);
  // We need both threadId and turnId to drive a retry. Failed-row metadata is
  // populated by applyTurnFailed, so the missing-id case only matters during
  // hand-rolled fixtures.
  const canRetry = Boolean(message.threadId && message.turnId);

  function handleRetry(modelOverride?: string) {
    if (!message.threadId || !message.turnId) return;
    setShowPicker(false);
    void retryFailedTurn(message.threadId, message.turnId, modelOverride ? { modelOverride } : undefined);
  }

  return (
    <div
      className="agnt-row agnt-row-system-error"
      title={new Date(message.createdAt).toLocaleString()}
    >
      <span className="agnt-row-tag agnt-row-system-error-tag">Turn failed</span>
      <span className="agnt-row-system-error-text">{message.text}</span>
      {canRetry && (
        <>
          <button
            type="button"
            className="agnt-row-action agnt-row-system-error-retry"
            onClick={() => handleRetry()}
            title="Re-issue the same prompt with the current model"
          >
            Retry
          </button>
          {models.length > 1 && (
            <button
              type="button"
              className="agnt-row-action"
              onClick={() => setShowPicker((open) => !open)}
              aria-expanded={showPicker}
              title="Retry with a different model — flake on one provider doesn't always reproduce on another"
            >
              Retry with…
            </button>
          )}
          {showPicker && (
            <div className="agnt-row-system-error-picker" role="menu">
              {models
                .filter((option) => option.id !== currentModel)
                .map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    role="menuitem"
                    className="agnt-row-system-error-picker-item"
                    onClick={() => handleRetry(option.id)}
                  >
                    {option.displayName ?? option.name ?? option.id}
                  </button>
                ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
