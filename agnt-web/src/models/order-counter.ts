// Monotonic global counter that stamps every message with a stable insertion order.
// Wallclock timestamps drift between client and bridge; orderIndex is the primary
// sort key in the chat timeline. Faithful port of CodexMessageOrderCounter.swift.

let counter = 0;

export const orderCounter = {
  next(): number {
    const value = counter;
    counter += 1;
    return value;
  },
  /**
   * Seed from persisted messages on app boot so newly-created rows always sort
   * after rows hydrated from IndexedDB. Idempotent.
   */
  seedFrom(maxExistingOrderIndex: number): void {
    if (maxExistingOrderIndex >= counter) counter = maxExistingOrderIndex + 1;
  },
  /** Test-only: snap the counter back to zero. */
  __resetForTests(): void {
    counter = 0;
  },
};
