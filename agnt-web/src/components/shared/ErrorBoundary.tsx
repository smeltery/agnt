// Top-level error boundary so a render-time crash anywhere in the tree
// surfaces as a recoverable card instead of a blank white page. We log the
// error to `console.error` so it lands in the browser's devtools (and our
// service worker's network log if any), and the diagnostic-report
// download surfaces a recent-error count separately.
//
// The fallback is intentionally minimal — we can't trust any styled
// component to render after an unknown crash, so we use inline styles +
// the iOS palette tokens directly.

import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string }): void {
    // Log enough to diagnose without leaking private state. The user can
    // copy the page to a bug report if needed.
    // eslint-disable-next-line no-console
    console.error("[agnt-web] uncaught render error", error, info?.componentStack);
  }

  reset = () => {
    this.setState({ error: null });
  };

  reload = () => {
    if (typeof window !== "undefined") window.location.reload();
  };

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div
        role="alert"
        style={{
          minHeight: "100dvh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          background: "var(--agnt-bg, #000)",
          color: "var(--agnt-fg, #fff)",
          fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
        }}
      >
        <div
          style={{
            maxWidth: 480,
            width: "100%",
            background: "var(--agnt-bg-elev, #1c1c1e)",
            borderRadius: 18,
            padding: 24,
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em" }}>
            Something broke
          </h1>
          <p style={{ margin: 0, color: "var(--agnt-fg-dim, rgba(235,235,245,0.6))" }}>
            agnt-web hit an unexpected error and couldn't keep rendering. Reloading usually
            recovers; if it keeps happening, export a diagnostic report from Settings.
          </p>
          <pre
            style={{
              margin: 0,
              padding: "10px 12px",
              background: "var(--agnt-bg, #000)",
              borderRadius: 12,
              fontSize: 12,
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              maxHeight: 200,
              overflow: "auto",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {this.state.error.message || String(this.state.error)}
          </pre>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button
              type="button"
              onClick={this.reset}
              style={{
                padding: "8px 14px",
                borderRadius: 14,
                border: 0,
                background: "var(--agnt-bg-elev-2, rgba(118,118,128,0.24))",
                color: "var(--agnt-fg, #fff)",
                font: "inherit",
                fontWeight: 500,
                cursor: "pointer",
              }}
            >
              Try again
            </button>
            <button
              type="button"
              onClick={this.reload}
              style={{
                padding: "8px 14px",
                borderRadius: 14,
                border: 0,
                background: "var(--agnt-accent, #0a84ff)",
                color: "#fff",
                font: "inherit",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Reload
            </button>
          </div>
        </div>
      </div>
    );
  }
}
