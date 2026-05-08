// Copy a permalink to a specific message row. The hash routing is owned by
// `lib/hash-routing.ts`; this component just wraps the existing
// `lib/clipboard.ts` fallback path with the row-action styling so the copy
// affordance feels at home next to Bookmark/Reply.

import { useState } from "react";
import { copyText } from "../../../lib/clipboard";
import { buildPermalink } from "../../../lib/hash-routing";

interface Props {
  threadId: string | undefined;
  messageId: string;
}

export function RowLinkButton({ threadId, messageId }: Props) {
  const [justCopied, setJustCopied] = useState(false);
  if (!threadId) return null;
  async function copy() {
    if (typeof window === "undefined") return;
    const link = buildPermalink(window.location.origin, window.location.pathname, {
      threadId,
      messageId,
    });
    const ok = await copyText(link);
    if (!ok) return;
    setJustCopied(true);
    window.setTimeout(() => setJustCopied(false), 1200);
  }
  return (
    <button
      type="button"
      className={"agnt-row-action" + (justCopied ? " agnt-row-action-done" : "")}
      onClick={() => void copy()}
      title="Copy a permalink to this message"
      aria-label={justCopied ? "Link copied" : "Copy permalink"}
    >
      {justCopied ? "Linked" : "🔗"}
    </button>
  );
}
