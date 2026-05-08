// "New Chat" composer. Pairs a first-turn prompt with an optional project
// folder. Submitting calls thread/start with both; the resulting thread is
// auto-selected so the chat view paints immediately.

import { useState } from "react";
import { useThreadsStore } from "../../state/threads-store";

interface NewChatModalProps {
  onClose(): void;
  onPickProject(callback: (path: string) => void): void;
  /** Pre-filled cwd — used by the "Duplicate thread" context-menu action so a
   *  cloned thread inherits the source's project without an extra click. */
  initialCwd?: string;
  /** Pre-filled prompt — used by Duplicate so the user can review/tweak the
   *  starter turn before it ships. */
  initialPrompt?: string;
}

export function NewChatModal({ onClose, onPickProject, initialCwd, initialPrompt }: NewChatModalProps) {
  const startNewThread = useThreadsStore((state) => state.startNewThread);
  const [prompt, setPrompt] = useState(initialPrompt ?? "");
  const [cwd, setCwd] = useState<string | null>(initialCwd ?? null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const text = prompt.trim();
    if (!text || submitting) return;
    setSubmitting(true);
    const id = await startNewThread({ content: text, cwd: cwd ?? undefined });
    setSubmitting(false);
    if (id) onClose();
  }
  // Attachments here are intentionally not surfaced — first-turn images can
  // be sent via the in-thread composer once the thread exists. Folding image
  // ingestion into this modal would double the surface and we'd still need
  // the in-thread path. Keep New Chat focused on prompt + cwd.

  return (
    <div className="agnt-modal-backdrop" role="presentation" onClick={onClose}>
      <form
        className="agnt-modal agnt-newchat-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="agnt-newchat-title"
        onClick={(event) => event.stopPropagation()}
        onSubmit={submit}
      >
        <header className="agnt-modal-header">
          <h2 id="agnt-newchat-title">New chat</h2>
        </header>
        <section className="agnt-modal-body">
          <label className="agnt-input-field">
            <legend>
              <span className="agnt-input-field-header">Project folder</span>
              <span>Where the agent runs commands and reads files.</span>
            </legend>
            <div className="agnt-newchat-cwd-row">
              <code className="agnt-newchat-cwd">{cwd ?? "Bridge default"}</code>
              <button
                type="button"
                className="agnt-button-ghost"
                onClick={() => onPickProject((path) => setCwd(path))}
              >
                {cwd ? "Change…" : "Pick…"}
              </button>
              {cwd && (
                <button type="button" className="agnt-button-ghost" onClick={() => setCwd(null)} title="Use bridge default">
                  Reset
                </button>
              )}
            </div>
          </label>

          <label className="agnt-input-field">
            <legend>
              <span className="agnt-input-field-header">First message</span>
              <span>The agent will reply in a new thread.</span>
            </legend>
            <textarea
              className="agnt-newchat-prompt"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Describe what you want the agent to do…"
              rows={5}
              autoFocus
              spellCheck={false}
            />
          </label>
        </section>
        <footer className="agnt-modal-footer">
          <button type="button" className="agnt-button-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="agnt-button-primary" disabled={submitting || !prompt.trim()}>
            {submitting ? "Starting…" : "Start"}
          </button>
        </footer>
      </form>
    </div>
  );
}
