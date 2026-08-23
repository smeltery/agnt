// Compact About card. Version is injected by Vite via __APP_VERSION__ at build
// time so the bundle doesn't need to read package.json at runtime.

declare const __APP_VERSION__: string;

export function AboutModal({ onClose }: { onClose(): void }) {
  return (
    <div className="agnt-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="agnt-modal agnt-about-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="agnt-about-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="agnt-modal-header">
          <h2 id="agnt-about-title">agnt-web</h2>
        </header>
        <section className="agnt-modal-body">
          <p>Browser client for the agnt bridge stack.</p>
          <dl className="agnt-settings-kv">
            <dt>Version</dt>
            <dd>{typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "0.0.0"}</dd>
            <dt>Source</dt>
            <dd>
              <a href="https://github.com/smeltery/agnt" target="_blank" rel="noreferrer">
                github.com/smeltery/agnt
              </a>
            </dd>
            <dt>License</dt>
            <dd>PolyForm Shield 1.0.0</dd>
          </dl>
        </section>
        <footer className="agnt-modal-footer">
          <button type="button" className="agnt-button-primary" onClick={onClose}>
            Close
          </button>
        </footer>
      </div>
    </div>
  );
}
