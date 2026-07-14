// FILE: desktop-ipc-action-follower-active-threads.js
// Purpose: Tracks phone-interested Desktop threads with bounded recency eviction.
// Layer: CLI helper
// Exports: createActiveThreadCache

function createActiveThreadCache({
  maxSize,
  isEvictable = () => true,
  onEvict = () => {},
} = {}) {
  const activeThreadIds = new Set();

  function remember(threadId) {
    activeThreadIds.delete(threadId);
    activeThreadIds.add(threadId);
    while (activeThreadIds.size > maxSize) {
      const oldest = oldestEvictable();
      if (oldest === undefined) {
        break;
      }
      activeThreadIds.delete(oldest);
      onEvict(oldest);
    }
  }

  function oldestEvictable() {
    for (const threadId of activeThreadIds) {
      if (isEvictable(threadId)) {
        return threadId;
      }
    }
    return undefined;
  }

  return {
    clear() {
      activeThreadIds.clear();
    },
    delete(threadId) {
      activeThreadIds.delete(threadId);
    },
    has(threadId) {
      return activeThreadIds.has(threadId);
    },
    remember,
  };
}

module.exports = {
  createActiveThreadCache,
};
