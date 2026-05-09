// Per-row star toggle. Reads + writes the bookmarks store directly so each
// row can subscribe to just its own bookmarked-state slice without churning
// when other rows toggle.

import { useBookmarksStore } from "../../../state/bookmarks-store";
import { Star, StarFill } from "../../shared/Icon";

interface BookmarkButtonProps {
  threadId: string | undefined;
  messageId: string;
}

export function BookmarkButton({ threadId, messageId }: BookmarkButtonProps) {
  // No threadId means we can't disambiguate which thread to bookmark under;
  // hide the button rather than push a "where do I file this" decision onto
  // the store. (Happens for in-flight rows before the bridge stamps the id.)
  const bookmarked = useBookmarksStore((state) =>
    threadId ? Boolean(state.byThread[threadId]?.has(messageId)) : false
  );
  const toggle = useBookmarksStore((state) => state.toggle);
  if (!threadId) return null;
  return (
    <button
      type="button"
      className={"agnt-row-action agnt-row-bookmark" + (bookmarked ? " agnt-row-bookmark-on" : "")}
      onClick={() => toggle(threadId, messageId)}
      aria-pressed={bookmarked}
      aria-label={bookmarked ? "Remove bookmark" : "Bookmark this message"}
      title={bookmarked ? "Bookmarked — click to remove" : "Bookmark"}
    >
      {bookmarked ? <StarFill /> : <Star />}
    </button>
  );
}
