function pageByAnchor(items, { cursor, limit = 50, sortDirection = "desc" } = {}, kind = "turn") {
  const direction = sortDirection === "asc" ? "asc" : "desc";
  const ordered = direction === "desc" ? [...items].reverse() : [...items];
  const prefix = `agnt-opencode-${kind}:${direction}:`;
  let start = 0;
  if (cursor) {
    if (typeof cursor !== "string" || !cursor.startsWith(prefix)) throw new Error("Invalid history cursor; reload this chat.");
    const id = decodeURIComponent(cursor.slice(prefix.length));
    const index = ordered.findIndex((item) => item.id === id);
    if (index < 0) throw new Error("History changed; reload this chat.");
    start = index + 1;
  }
  const size = Math.max(1, Math.min(Number(limit) || 50, 200));
  const data = ordered.slice(start, start + size);
  const hasMore = start + data.length < ordered.length;
  return { data, hasMore, nextCursor: hasMore ? prefix + encodeURIComponent(data.at(-1).id) : null };
}

module.exports = { pageByAnchor };
