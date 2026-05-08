// Tagged console logger so the browser DevTools filter mirrors the iOS [CodexSecure] convention.

const ENABLED = (() => {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem("agnt:debug") !== "off";
  } catch {
    return true;
  }
})();

function emit(tag: string, level: "log" | "warn" | "error", parts: unknown[]) {
  if (!ENABLED && level === "log") return;
  // eslint-disable-next-line no-console
  console[level](`[agnt:${tag}]`, ...parts);
}

export function makeLogger(tag: string) {
  return {
    debug: (...parts: unknown[]) => emit(tag, "log", parts),
    warn: (...parts: unknown[]) => emit(tag, "warn", parts),
    error: (...parts: unknown[]) => emit(tag, "error", parts),
  };
}
