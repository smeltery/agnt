// FILE: desktop-turns-pagination.js
// Purpose: Builds paginated turns/list responses for projected Desktop IPC snapshots.
// Layer: CLI helper
// Exports: buildDesktopTurnsListResult, isDesktopTurnsCursor
// Depends on: crypto, ./desktop-ipc-shared

const { createHash } = require("crypto");
const {
  cloneJSON,
  normalizeToken,
  readString,
} = require("./desktop-ipc-shared");

const DESKTOP_TURNS_CURSOR_PREFIX = "agnt-desktop-turns:";

function buildDesktopTurnsListResult(turns, params = {}) {
  const chronologicalTurns = Array.isArray(turns) ? turns : [];
  const snapshotRevision = desktopTurnsSnapshotRevision(chronologicalTurns);
  const direction = normalizeToken(readString(params?.sortDirection) || "desc") === "asc"
    ? "asc"
    : "desc";
  const orderedTurns = direction === "asc"
    ? chronologicalTurns.slice()
    : chronologicalTurns.slice().reverse();

  let startIndex = 0;
  const cursor = readString(params?.cursor);
  if (cursor) {
    const parsedCursor = parseDesktopTurnsCursor(
      cursor,
      direction,
      snapshotRevision,
      orderedTurns
    );
    if (parsedCursor == null) {
      return null;
    }
    startIndex = parsedCursor;
  }

  const requestedLimit = Number(params?.limit);
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
    ? Math.floor(requestedLimit)
    : orderedTurns.length;
  const page = orderedTurns.slice(startIndex, startIndex + limit);
  const hasMore = startIndex + page.length < orderedTurns.length;
  const nextCursor = hasMore && page.length > 0
    ? desktopTurnsCursor(
      direction,
      snapshotRevision,
      page[page.length - 1],
      startIndex + page.length
    )
    : null;

  return {
    data: cloneJSON(page),
    nextCursor,
    hasMore,
  };
}

function isDesktopTurnsCursor(value) {
  return readString(value).startsWith(DESKTOP_TURNS_CURSOR_PREFIX);
}

function desktopTurnsCursor(direction, snapshotRevision, turn, nextIndex) {
  const turnId = readString(turn?.id)
    || readString(turn?.turnId)
    || readString(turn?.turn_id);
  const anchor = turnId ? `id:${encodeURIComponent(turnId)}` : `index:${nextIndex}`;
  return `${DESKTOP_TURNS_CURSOR_PREFIX}${direction}:${snapshotRevision}:${anchor}`;
}

function parseDesktopTurnsCursor(cursor, direction, snapshotRevision, orderedTurns) {
  const prefix = `${DESKTOP_TURNS_CURSOR_PREFIX}${direction}:${snapshotRevision}:`;
  if (!cursor.startsWith(prefix)) {
    return null;
  }
  const anchor = cursor.slice(prefix.length);
  if (anchor.startsWith("id:")) {
    let turnId = "";
    try {
      turnId = decodeURIComponent(anchor.slice(3));
    } catch {
      return null;
    }
    const anchorIndex = orderedTurns.findIndex((turn) => (
      readString(turn?.id) === turnId
      || readString(turn?.turnId) === turnId
      || readString(turn?.turn_id) === turnId
    ));
    return anchorIndex === -1 ? null : anchorIndex + 1;
  }
  if (anchor.startsWith("index:")) {
    const parsedIndex = Number(anchor.slice(6));
    return Number.isInteger(parsedIndex) && parsedIndex >= 0 && parsedIndex <= orderedTurns.length
      ? parsedIndex
      : null;
  }
  return null;
}

function desktopTurnsSnapshotRevision(turns) {
  const hash = createHash("sha256");
  const paginationStructure = (Array.isArray(turns) ? turns : []).map((turn) => ({
    id: readString(turn?.id) || readString(turn?.turnId) || readString(turn?.turn_id),
    input: turn?.input ?? turn?.prompt ?? null,
    userItems: (Array.isArray(turn?.items) ? turn.items : []).flatMap((item) => {
      const role = readString(item?.role).toLowerCase();
      const type = normalizeToken(readString(item?.type));
      const isUserItem = role === "user" || type === "usermessage";
      if (!isUserItem) {
        return [];
      }
      return [{
        id: readString(item?.id) || readString(item?.itemId) || readString(item?.item_id),
        role,
        type,
        userContent: item?.text ?? item?.content ?? null,
      }];
    }),
  }));
  hash.update(JSON.stringify(paginationStructure));
  return hash.digest("hex").slice(0, 24);
}

module.exports = {
  buildDesktopTurnsListResult,
  isDesktopTurnsCursor,
};
