// Fire-and-forget POST to a user-configured URL when a turn ends. Useful
// for hooking agnt into Slack, a local logger, or a follow-up automation
// script.
//
// Privacy: payload deliberately excludes message text. Sending model-
// generated content to a third-party URL is a data leak the user almost
// certainly didn't intend; the bridge already owns that channel. Stick to
// metadata.
//
// Reliability: we intentionally swallow failures — the webhook is a
// non-critical side effect, and a flaky URL shouldn't spawn toast spam on
// every turn. Errors land in `console.warn` so the diagnostic export can
// surface them indirectly via the recent-error log.

import { makeLogger } from "./log";
import { prefsStore } from "../storage/prefs-store";

const log = makeLogger("turn-webhook");

export type TurnWebhookOutcome = "completed" | "failed";

export interface TurnWebhookPayload {
  schemaVersion: 1;
  outcome: TurnWebhookOutcome;
  threadId: string;
  turnId?: string;
  timestamp: string;
  /** Optional human-readable error text from `turn/failed.error.message`. */
  errorText?: string;
}

export async function fireTurnWebhook(payload: TurnWebhookPayload): Promise<void> {
  const pref = await prefsStore.loadTurnWebhook();
  if (!pref.enabled || !pref.url.trim()) return;
  const url = pref.url.trim();
  // Only allow http(s) — `javascript:`, `file:`, etc. would be a footgun.
  if (!/^https?:\/\//i.test(url)) {
    log.warn("turn-webhook URL rejected (only http/https allowed)", url);
    return;
  }
  try {
    // `keepalive: true` lets the request survive a tab close — useful when
    // a turn finishes just as the user navigates away. `mode: "cors"` keeps
    // it explicit; the user is responsible for configuring CORS on the
    // receiving end (or accepting that opaque POSTs are fine).
    await fetch(url, {
      method: "POST",
      mode: "cors",
      keepalive: true,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    log.warn("turn-webhook POST failed", (error as Error)?.message);
  }
}
