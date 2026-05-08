// Toast surface for `system/notice` notifications (e.g. opencode tui.toast.show
// proxied through the bridge). Each notice auto-dismisses after `durationMs`
// (defaulting to 5s for info, 8s for warn, 12s for error).

import { create } from "zustand";

export type NoticeSeverity = "info" | "warn" | "error";

export interface Notice {
  id: string;
  severity: NoticeSeverity;
  title?: string;
  message?: string;
  provider?: string;
  threadId?: string;
}

interface NoticesState {
  notices: Notice[];
  enqueue(input: { severity?: string; title?: string; message?: string; provider?: string; threadId?: string; durationMs?: number }): void;
  dismiss(id: string): void;
}

const dismissTimers = new Map<string, ReturnType<typeof setTimeout>>();
const DEFAULT_DURATION_MS: Record<NoticeSeverity, number> = { info: 5_000, warn: 8_000, error: 12_000 };

export const useNoticesStore = create<NoticesState>((set, get) => ({
  notices: [],
  enqueue(input) {
    const severity = normalizeSeverity(input.severity);
    if (!input.title && !input.message) return;
    const id = crypto.randomUUID();
    const notice: Notice = {
      id,
      severity,
      title: input.title?.trim(),
      message: input.message?.trim(),
      provider: input.provider,
      threadId: input.threadId,
    };
    set({ notices: [...get().notices, notice] });
    const duration = input.durationMs && input.durationMs > 0 ? input.durationMs : DEFAULT_DURATION_MS[severity];
    if (typeof window !== "undefined") {
      dismissTimers.set(
        id,
        setTimeout(() => get().dismiss(id), duration)
      );
    }
  },
  dismiss(id) {
    const timer = dismissTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      dismissTimers.delete(id);
    }
    set({ notices: get().notices.filter((notice) => notice.id !== id) });
  },
}));

function normalizeSeverity(raw: unknown): NoticeSeverity {
  const value = typeof raw === "string" ? raw.toLowerCase() : "";
  if (value === "warn" || value === "warning") return "warn";
  if (value === "error" || value === "danger") return "error";
  return "info";
}
