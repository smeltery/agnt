// Keyboard-shortcut + drag-drop reference. Hand-curated so it stays accurate
// — no auto-discovery from the keyboard hooks (those are scattered across
// components and would need a registry; this is simpler and the shortcut
// surface is small).

const SECTIONS: Array<{
  heading: string;
  rows: Array<{ keys: string[]; description: string }>;
}> = [
  {
    heading: "Navigation",
    rows: [
      { keys: ["j"], description: "Next thread in sidebar" },
      { keys: ["k"], description: "Previous thread in sidebar" },
      { keys: ["/"], description: "Focus the composer" },
      { keys: ["f"], description: "Search this thread" },
      { keys: ["⌘ / Ctrl", "F"], description: "Search this thread (also captures the browser shortcut)" },
      { keys: ["?"], description: "Open this help" },
      { keys: ["Esc"], description: "Close any open modal" },
    ],
  },
  {
    heading: "Composer",
    rows: [
      { keys: ["⌘ / Ctrl", "Enter"], description: "Send the turn" },
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
    <div className="agnt-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="agnt-modal agnt-help-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="agnt-help-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="agnt-modal-header">
          <h2 id="agnt-help-title">Keyboard shortcuts</h2>
        </header>
        <section className="agnt-modal-body agnt-help-body">
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
    </div>
  );
}
