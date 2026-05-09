// Per-thread settings: system prompt + model + reasoning effort. Overrides
// the global picks from `TurnFlagBar` for this thread only — useful for a
// long-running thread that wants to pin a behavior (e.g. "be terse",
// "always use claude-sonnet") without re-setting flags every turn.
//
// Stored under `prefs.threadOverrides[threadId]`; empty fields are pruned
// on save so the persisted blob doesn't grow forever.

import { useEffect, useMemo, useState } from "react";
import type { CodexThread } from "../../models";
import type { ReasoningEffort } from "../../state/threads-store";
import { useThreadsStore } from "../../state/threads-store";
import { Sheet } from "../shared/Sheet";

const REASONING_EFFORTS: Array<{ value: "" | ReasoningEffort; label: string }> = [
  { value: "", label: "(global)" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

export function ThreadOverridesSheet({ thread, onClose }: { thread: CodexThread; onClose(): void }) {
  const overrides = useThreadsStore((state) => state.overridesByThread[thread.id]);
  const setThreadOverride = useThreadsStore((state) => state.setThreadOverride);
  const models = useThreadsStore((state) => state.models);
  const globalFlags = useThreadsStore((state) => state.turnFlags);

  // Drive the form off local state so a typo doesn't fire idb writes on
  // every keystroke; we persist on Save / Done.
  const [systemPrompt, setSystemPrompt] = useState(overrides?.systemPrompt ?? "");
  const [model, setModel] = useState(overrides?.model ?? "");
  const [reasoningEffort, setReasoningEffort] = useState<"" | ReasoningEffort>(
    (overrides?.reasoningEffort as ReasoningEffort | undefined) ?? ""
  );

  useEffect(() => {
    setSystemPrompt(overrides?.systemPrompt ?? "");
    setModel(overrides?.model ?? "");
    setReasoningEffort((overrides?.reasoningEffort as ReasoningEffort | undefined) ?? "");
  }, [overrides]);

  const fallbackModel = useMemo(() => globalFlags.model ?? "(bridge default)", [globalFlags.model]);
  const fallbackEffort = useMemo(() => globalFlags.reasoningEffort ?? "(bridge default)", [globalFlags.reasoningEffort]);

  async function persist() {
    await setThreadOverride(thread.id, {
      systemPrompt: systemPrompt.trim() ? systemPrompt : undefined,
      model: model || undefined,
      reasoningEffort: reasoningEffort || undefined,
    });
    onClose();
  }
  async function clearAll() {
    await setThreadOverride(thread.id, { systemPrompt: undefined, model: undefined, reasoningEffort: undefined });
    onClose();
  }

  return (
    <Sheet open onClose={onClose} ariaLabel="Thread overrides" maxWidth={620}>
      <header className="agnt-modal-header">
        <h2>Thread overrides</h2>
        <p className="agnt-settings-hint">
          Pin a model / effort / system prompt for <strong>{thread.name ?? thread.title ?? "this thread"}</strong>.
          Empty fields fall back to the global picks ({fallbackModel} · {fallbackEffort}).
        </p>
      </header>
      <section className="agnt-modal-body">
        <label className="agnt-input-field">
          <legend>
            <span className="agnt-input-field-header">System prompt</span>
            <span>Prepended to every turn in this thread.</span>
          </legend>
          <textarea
            className="agnt-newchat-prompt"
            value={systemPrompt}
            onChange={(event) => setSystemPrompt(event.target.value)}
            rows={4}
            placeholder="Be terse. Always cite the file path. …"
            spellCheck={false}
          />
        </label>
        <label className="agnt-input-field">
          <legend>
            <span className="agnt-input-field-header">Model</span>
            <span>Overrides the per-turn model pick.</span>
          </legend>
          <select
            className="agnt-pairing-input"
            value={model}
            onChange={(event) => setModel(event.target.value)}
          >
            <option value="">(global · {fallbackModel})</option>
            {models.map((option) => (
              <option key={option.id} value={option.id}>
                {option.displayName ?? option.name ?? option.id}
              </option>
            ))}
          </select>
        </label>
        <label className="agnt-input-field">
          <legend>
            <span className="agnt-input-field-header">Reasoning effort</span>
            <span>Overrides the per-turn effort pick.</span>
          </legend>
          <div className="agnt-settings-segments" role="radiogroup" aria-label="Reasoning effort">
            {REASONING_EFFORTS.map((option) => (
              <button
                key={option.value || "(global)"}
                type="button"
                role="radio"
                aria-checked={reasoningEffort === option.value}
                className={"agnt-settings-segment" + (reasoningEffort === option.value ? " agnt-settings-segment-active" : "")}
                onClick={() => setReasoningEffort(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </label>
      </section>
      <footer className="agnt-modal-footer">
        <button type="button" className="agnt-button-ghost agnt-button-danger" onClick={() => void clearAll()}>
          Clear all
        </button>
        <button type="button" className="agnt-button-ghost" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="agnt-button-primary" onClick={() => void persist()}>
          Save
        </button>
      </footer>
    </Sheet>
  );
}
