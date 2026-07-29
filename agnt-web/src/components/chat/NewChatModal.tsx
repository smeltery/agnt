// "New Chat" composer. Pairs a first-turn prompt with an optional project
// folder. Submitting calls thread/start with both; the resulting thread is
// auto-selected so the chat view paints immediately.

import { useState } from "react";
import { useThreadsStore } from "../../state/threads-store";
import { Sheet } from "../shared/Sheet";
import { ComposerDevicePicker } from "./ComposerDevicePicker";

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

/** Quick-start chips that drop a tested prompt into the textarea. Kept
 *  as a flat list rather than a category tree — agnt is for engineering
 *  work, not a general-purpose chat product, so 4-6 chips covering the
 *  common day-1 tasks beats a "browse templates" sub-modal.
 *
 *  We deliberately keep the bodies terse and outcome-shaped: the user
 *  finishes the prompt with their specific repo / file / question. */
const STARTER_PROMPTS: ReadonlyArray<{ label: string; body: string }> = [
  {
    label: "Explain the codebase",
    body: "Give me a tour of this repo: top-level layout, the main entry points, how requests flow end-to-end, and where I'd start reading if I had to ship a small change.",
  },
  {
    label: "Review my changes",
    body: "Look at the unstaged changes in this repo. Flag bugs, missing edge cases, and anything that would surprise a future reader. Keep the review concise; reference file:line for each call-out.",
  },
  {
    label: "Write tests",
    body: "Add tests for the most recently edited file. Cover the happy path, the obvious edge cases, and any branch the existing tests miss.",
  },
  {
    label: "Find a bug",
    body: "I'm seeing this issue: <describe>. Check the relevant module(s), confirm the root cause, and propose the smallest fix that doesn't regress the existing behavior.",
  },
  {
    label: "Refactor a function",
    body: "Refactor the most recently edited function for readability. Don't change behavior; keep the same public signature unless I confirm a rename.",
  },
];

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
    <Sheet open onClose={onClose} ariaLabel="New chat" maxWidth={640}>
      <form
        className="agnt-newchat-modal"
        onSubmit={submit}
      >
        <header className="agnt-modal-header">
          <h2 id="agnt-newchat-title">New chat</h2>
        </header>
        <section className="agnt-modal-body">
          <div className="agnt-newchat-run-on-row">
            <ComposerDevicePicker />
          </div>

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
            {/* Starter chips: only render when the user hasn't typed
                anything yet so they don't get in the way of editing.
                Clicking one drops the prompt into the textarea — the
                user can still tweak before submitting. */}
            {!prompt.trim() && (
              <div className="agnt-newchat-starters" role="group" aria-label="Starter prompts">
                {STARTER_PROMPTS.map((starter) => (
                  <button
                    key={starter.label}
                    type="button"
                    className="agnt-newchat-starter"
                    onClick={() => setPrompt(starter.body)}
                    title={starter.body}
                  >
                    {starter.label}
                  </button>
                ))}
              </div>
            )}
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
    </Sheet>
  );
}
