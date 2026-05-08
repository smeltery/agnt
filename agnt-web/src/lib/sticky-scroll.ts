// Sticky-follow scroll behavior. Tracks whether the user is "near the bottom"
// of a scrollable container; if so, every layout pass keeps the bottom
// anchored as new content arrives. The moment the user scrolls up we drop
// out of follow mode so streaming deltas don't yank them away from what
// they were reading.
//
// Designed for the chat view where messages mutate in place during streaming
// (each delta extends the last message's text, the messages array reference
// changes, but the count doesn't). useEffect on messages.length isn't
// enough — we re-anchor after every render the consumer wants to track.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/** Pixel threshold for considering the user "at the bottom". */
const FOLLOW_THRESHOLD_PX = 48;

export interface StickyScrollHandle {
  scrollRef: React.RefObject<HTMLDivElement>;
  /** True when the next render should auto-scroll to the bottom. */
  isFollowing: boolean;
  /** True only when the user is meaningfully scrolled away from the bottom. */
  showJumpButton: boolean;
  jumpToBottom(): void;
}

export function useStickyScroll(deps: React.DependencyList): StickyScrollHandle {
  const scrollRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const [isFollowing, setIsFollowing] = useState(true);
  const [showJumpButton, setShowJumpButton] = useState(false);

  const updateFollowState = useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;
    const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
    const atBottom = distanceFromBottom <= FOLLOW_THRESHOLD_PX;
    if (followingRef.current !== atBottom) {
      followingRef.current = atBottom;
      setIsFollowing(atBottom);
    }
    // Don't surface the jump button for trivial offsets — only when the user
    // is far enough away that pinning scroll would feel intrusive.
    setShowJumpButton(distanceFromBottom > FOLLOW_THRESHOLD_PX * 4);
  }, []);

  // useLayoutEffect runs synchronously after DOM mutation but before paint,
  // so the scroll anchor is in place before the user sees new content.
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    if (followingRef.current) {
      node.scrollTop = node.scrollHeight;
    } else {
      // Even when not following, refresh the jump-button visibility because
      // new content may have moved the user further from the bottom.
      updateFollowState();
    }
    // The deps array is the consumer's signal that a re-anchor pass is
    // worthwhile (e.g. messages array reference changed).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const onScroll = () => updateFollowState();
    node.addEventListener("scroll", onScroll, { passive: true });
    return () => node.removeEventListener("scroll", onScroll);
  }, [updateFollowState]);

  const jumpToBottom = useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
    followingRef.current = true;
    setIsFollowing(true);
    setShowJumpButton(false);
  }, []);

  return { scrollRef, isFollowing, showJumpButton, jumpToBottom };
}
