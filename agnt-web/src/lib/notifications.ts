// Browser desktop notifications. Wraps the Notification API with permission
// gating and a "user disabled this in our Settings" override layered on top
// of the platform permission. Coalesces per-thread completions via the `tag`
// option so a thread firing many turns in a row doesn't stack ten dock
// badges.
//
// We never spam notifications when the tab is focused — the inline UI is
// enough — and never request permission automatically; the user has to opt
// in from Settings so we don't trigger the browser's "this site wants to
// notify you" prompt unsolicited.

import { prefsStore } from "../storage/prefs-store";

export type NotificationsEnabledPreference = "auto" | "on" | "off";

export type NotificationPermissionLabel =
  | "default" // browser hasn't been asked yet
  | "granted"
  | "denied"
  | "unsupported"; // Notification API missing entirely

export interface ShowNotificationInput {
  title: string;
  body?: string;
  /** Coalesce key — repeat notifications with the same tag replace the prior. */
  tag?: string;
  /** Click handler runs in the parent context; usually focuses the window. */
  onClick?(): void;
}

const TAG_PREFIX = "agnt:";

export function permissionLabel(): NotificationPermissionLabel {
  // We only need the Notification constructor to be present; node tests stub
  // it onto globalThis directly, and browsers expose it on window which is
  // also globalThis. Checking `typeof window` would falsely report
  // "unsupported" in the test environment.
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission as NotificationPermissionLabel;
}

export async function requestPermission(): Promise<NotificationPermissionLabel> {
  if (typeof Notification === "undefined") return "unsupported";
  if (Notification.permission === "granted" || Notification.permission === "denied") {
    return Notification.permission as NotificationPermissionLabel;
  }
  try {
    const result = await Notification.requestPermission();
    return result as NotificationPermissionLabel;
  } catch {
    return "denied";
  }
}

export async function shouldNotify(): Promise<boolean> {
  if (permissionLabel() !== "granted") return false;
  if (typeof document !== "undefined" && !document.hidden) return false;
  const preference = await prefsStore.loadNotifications();
  return preference !== "off";
}

export function showNotification(input: ShowNotificationInput): void {
  if (typeof Notification === "undefined") return;
  if (Notification.permission !== "granted") return;
  try {
    const notification = new Notification(input.title, {
      body: input.body,
      tag: input.tag ? `${TAG_PREFIX}${input.tag}` : undefined,
    });
    notification.onclick = () => {
      try {
        window.focus();
      } catch {
        // Some browsers refuse focus() when the source isn't a user gesture;
        // the notification click itself counts on most, but we don't fail
        // the rest of the click handler if it doesn't.
      }
      input.onClick?.();
      notification.close();
    };
  } catch {
    // Notification construction can throw on iOS Safari and inside service-
    // worker contexts that the user landed in via dev tools; silently drop.
  }
}
