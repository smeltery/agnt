// Keyboard-shortcut + drag-drop reference. Hand-curated so it stays accurate
// — no auto-discovery from the keyboard hooks (those are scattered across
// components and would need a registry; this is simpler and the shortcut
// surface is small).

import { Sheet } from "./Sheet";

const SECTIONS: Array<{
  heading: string;
  rows: Array<{ keys: string[]; description: string }>;
}> = [
  {
    heading: "Navigation",
    rows: [
      { keys: ["j"], description: "Next thread in sidebar" },
      { keys: ["k"], description: "Previous thread in sidebar" },
      { keys: ["["], description: "Jump to previous user message in this thread" },
      { keys: ["]"], description: "Jump to next user message in this thread" },
      { keys: ["/"], description: "Focus the composer" },
      { keys: ["f"], description: "Search this thread" },
      { keys: ["⌘ / Ctrl", "F"], description: "Search this thread (also captures the browser shortcut)" },
      { keys: ["⌘ / Ctrl", "K"], description: "Search across all threads" },
      { keys: ["n"], description: "Open the New Chat modal" },
      { keys: ["p"], description: "Pin / unpin the active thread" },
      { keys: ["e"], description: "Export the active thread to Markdown" },
      { keys: ["r"], description: "Revert the last completed turn (workspace checkpoint)" },
      { keys: ["?"], description: "Open this help" },
      { keys: ["Esc"], description: "Close any open modal" },
    ],
  },
  {
    heading: "Composer",
    rows: [
      { keys: ["⌘ / Ctrl", "Enter"], description: "Send the turn" },
      { keys: ["⌘ / Ctrl", "Shift", "F"], description: "Find / replace in the draft" },
      { keys: ["/"], description: "Open the slash command menu (compact / fork / archive / stop / …)" },
      { keys: ["↑"], description: "Recall the previous prompt (when draft is empty)" },
      { keys: ["↓"], description: "Step forward through recalled prompts" },
      { keys: ["Esc"], description: "Cancel recall and restore your in-progress draft" },
      { keys: ["Drop image"], description: "Attach an image" },
      { keys: ["Drop text file"], description: "Inline file contents as a fenced code block" },
      { keys: ["Paste image"], description: "Attach a clipboard image" },
    ],
  },
  {
    heading: "Sidebar",
    rows: [
      { keys: ["+ New"], description: "Start a new chat (with optional project picker)" },
      { keys: ["⋯"], description: "Rename / fork / archive / compact / export" },
    ],
  },
];

export function HelpModal({ onClose }: { onClose(): void }) {
  return (
    <Sheet open onClose={onClose} ariaLabel="Keyboard shortcuts" maxWidth={620}>
      <div className="agnt-help-modal">
        <header className="agnt-modal-header">
          <h2 id="agnt-help-title">Keyboard shortcuts</h2>
        </header>
        <section className="agnt-help-body">
          {SECTIONS.map((section) => (
            <div key={section.heading} className="agnt-help-section">
              <h3>{section.heading}</h3>
              <ul>
                {section.rows.map((row, index) => (
                  <li key={index}>
                    <span className="agnt-help-keys">
                      {row.keys.map((key, keyIndex) => (
                        <kbd key={keyIndex}>{key}</kbd>
                      ))}
                    </span>
                    <span className="agnt-help-description">{row.description}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
        <footer className="agnt-modal-footer">
          <button type="button" className="agnt-button-primary" onClick={onClose}>
            Got it
          </button>
        </footer>
      </div>
    </Sheet>
  );
}
