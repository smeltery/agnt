// xterm.js host. Owns one Terminal instance + FitAddon and bridges:
//   • user keystrokes → onInput callback (UTF-8 encoded as Uint8Array)
//   • container resize → onResize callback (cols, rows)
//   • incoming output bytes → terminal.write
//
// History bytes (for replays after navigation/recompose) are written once
// when the terminal mounts; subsequent live bytes come through `onOutput`
// subscription via the parent store.

import { useEffect, useMemo, useRef } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

export interface TerminalTheme {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  palette: string[]; // 16 colors, ANSI order
}

export const TERMINAL_THEME_DARK: TerminalTheme = {
  background: "#0a0a0a",
  foreground: "#adadb1",
  cursor: "#009fff",
  cursorAccent: "#0a0a0a",
  selectionBackground: "#2e2e30",
  palette: [
    "#141415", "#ff2e3f", "#0dbe4e", "#ffca00",
    "#009fff", "#c635e4", "#08c0ef", "#c6c6c8",
    "#141415", "#ff2e3f", "#0dbe4e", "#ffca00",
    "#009fff", "#c635e4", "#08c0ef", "#c6c6c8",
  ],
};

export const TERMINAL_THEME_LIGHT: TerminalTheme = {
  background: "#f2f2f7",
  foreground: "#6C6C71",
  cursor: "#009fff",
  cursorAccent: "#f2f2f7",
  selectionBackground: "#eeeeef",
  palette: TERMINAL_THEME_DARK.palette,
};

interface TerminalSurfaceProps {
  /**
   * Identity for this terminal instance — when this string changes (because
   * the user opened a new session) the xterm is reset and seeded again.
   */
  terminalKey: string;
  initialHistoryBase64: string;
  fontSize: number;
  theme: TerminalTheme;
  /**
   * Subscribe to incremental output bytes. Returns an unsubscribe fn. The
   * surface attaches once per mount; the parent store invokes the listener
   * for each notification.
   */
  subscribeOutput: (listener: (bytes: Uint8Array) => void) => () => void;
  onInput: (bytes: Uint8Array) => void;
  onResize: (cols: number, rows: number) => void;
}

export function TerminalSurface(props: TerminalSurfaceProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const onInputRef = useRef(props.onInput);
  const onResizeRef = useRef(props.onResize);

  // Keep callback refs fresh without restarting the terminal.
  useEffect(() => { onInputRef.current = props.onInput; }, [props.onInput]);
  useEffect(() => { onResizeRef.current = props.onResize; }, [props.onResize]);

  const themeForXterm = useMemo<ITheme>(() => themeToXterm(props.theme), [props.theme]);

  // Recreate xterm on key change. This deliberately drops the old buffer —
  // a session swap means we want a fresh display.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const terminal = new Terminal({
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      fontSize: props.fontSize,
      cursorBlink: true,
      scrollback: 5000,
      convertEol: false,
      theme: themeForXterm,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container);
    terminalRef.current = terminal;
    fitAddonRef.current = fit;

    // utf-8 input from the user
    const encoder = new TextEncoder();
    const dataDisposable = terminal.onData((data) => {
      onInputRef.current(encoder.encode(data));
    });
    // raw 8-bit (e.g. paste of binary) — still goes through utf-8 to the bridge
    const binaryDisposable = terminal.onBinary((data) => {
      const bytes = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i) & 0xff;
      onInputRef.current(bytes);
    });
    const resizeDisposable = terminal.onResize((event) => {
      onResizeRef.current(event.cols, event.rows);
    });

    // Seed history (if any).
    if (props.initialHistoryBase64) {
      terminal.write(decodeBase64(props.initialHistoryBase64));
    }

    // Initial fit + emit cols/rows.
    requestAnimationFrame(() => {
      try { fit.fit(); } catch { /* container not laid out yet */ }
    });

    // Live output subscription.
    const unsubscribe = props.subscribeOutput((bytes) => {
      terminal.write(bytes);
    });

    // Container resize → refit.
    const observer = new ResizeObserver(() => {
      try { fit.fit(); } catch { /* container has 0 size briefly */ }
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      unsubscribe();
      dataDisposable.dispose();
      binaryDisposable.dispose();
      resizeDisposable.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
    // Intentionally omit theme/fontSize/subscribeOutput so prop-driven updates
    // are handled by the dedicated effects below — avoids tearing down xterm.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.terminalKey]);

  // Theme + font size updates.
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.theme = themeForXterm;
    terminal.options.fontSize = props.fontSize;
    try { fitAddonRef.current?.fit(); } catch { /* layout might be 0 */ }
  }, [themeForXterm, props.fontSize]);

  return (
    <div
      ref={containerRef}
      className="agnt-terminal-surface"
      style={{ width: "100%", height: "100%", background: props.theme.background }}
    />
  );
}

function themeToXterm(theme: TerminalTheme): ITheme {
  return {
    background: theme.background,
    foreground: theme.foreground,
    cursor: theme.cursor,
    cursorAccent: theme.cursorAccent,
    selectionBackground: theme.selectionBackground,
    black: theme.palette[0],
    red: theme.palette[1],
    green: theme.palette[2],
    yellow: theme.palette[3],
    blue: theme.palette[4],
    magenta: theme.palette[5],
    cyan: theme.palette[6],
    white: theme.palette[7],
    brightBlack: theme.palette[8],
    brightRed: theme.palette[9],
    brightGreen: theme.palette[10],
    brightYellow: theme.palette[11],
    brightBlue: theme.palette[12],
    brightMagenta: theme.palette[13],
    brightCyan: theme.palette[14],
    brightWhite: theme.palette[15],
  };
}

function decodeBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
