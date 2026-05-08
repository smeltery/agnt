// URL-hash deep linking. We encode the active thread (and optionally an
// active message id) in the URL fragment so a shared link or page reload
// restores the same view. The hash format is intentionally tiny:
//
//   #thread/<id>
//   #thread/<id>/message/<id>
//
// Plain `?query` would work too but the hash leaves the path/origin alone,
// which is friendlier for static-host setups behind reverse proxies.

export interface HashLocation {
  threadId?: string;
  messageId?: string;
}

const PREFIX = "#thread/";

export function parseHashLocation(hash: string): HashLocation {
  if (!hash || !hash.startsWith(PREFIX)) return {};
  const rest = hash.slice(PREFIX.length);
  // `<threadId>` or `<threadId>/message/<messageId>`
  const messageMarker = "/message/";
  const messageIndex = rest.indexOf(messageMarker);
  if (messageIndex < 0) {
    const threadId = decodeURIComponent(rest);
    return threadId ? { threadId } : {};
  }
  const threadId = decodeURIComponent(rest.slice(0, messageIndex));
  const messageId = decodeURIComponent(rest.slice(messageIndex + messageMarker.length));
  if (!threadId) return {};
  return messageId ? { threadId, messageId } : { threadId };
}

export function buildHashLocation(location: HashLocation): string {
  if (!location.threadId) return "";
  const base = PREFIX + encodeURIComponent(location.threadId);
  if (!location.messageId) return base;
  return `${base}/message/${encodeURIComponent(location.messageId)}`;
}

/** Compose an absolute permalink the user can copy + paste anywhere. */
export function buildPermalink(origin: string, pathname: string, location: HashLocation): string {
  return `${origin}${pathname}${buildHashLocation(location)}`;
}
