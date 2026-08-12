// FILE: action-follower/review-overlay-replay.js
// Purpose: Drains guardian auto-approval-review overlays that live only in
//   normalized (canonical) history so idle Desktop-mirrored threads still
//   replay them as synthetic item/autoApprovalReview/* notifications.
// Layer: CLI helper
// Depends on: ../desktop-ipc-shared, ../desktop-ipc-action-follower-support, ./state

const { createHash } = require("crypto");
const {
  cloneJSON,
  normalizeToken,
  readString,
} = require("../desktop-ipc-shared");
const { DESKTOP_IPC_ACTION_SOURCE } = require("../desktop-ipc-action-follower-support");
const { normalizedTurnIdForEntity, normalizedTurnStore } = require("./state");

// Bounds the per-thread dedup cache so a long-lived idle thread with many
// historical reviews cannot grow this map without limit.
const MAX_NORMALIZED_REVIEW_FINGERPRINTS_PER_THREAD = 128;
const AUTO_APPROVAL_REVIEW_ITEM_ID_PREFIX = "automatic-approval-review:";

// Walks normalized-history entities that have no counterpart in the raw
// (bounded) turns array and collects their automaticApprovalReview items.
// Those turns never reach the projector, so without this, an idle
// Desktop-mirrored thread would never deliver guardian reviews that only
// exist in canonical history.
function collectPendingReviewOverlays(rawState) {
  const store = normalizedTurnStore(rawState);
  if (!store) {
    return [];
  }
  const rawTurnIds = new Set((Array.isArray(rawState?.turns) ? rawState.turns : [])
    .map((turn) => readString(turn?.id) || readString(turn?.turnId) || readString(turn?.turn_id))
    .filter(Boolean));

  const overlays = [];
  for (const [entityKey, entity] of Object.entries(store.entities)) {
    const turnId = normalizedTurnIdForEntity(entityKey, entity);
    if (!turnId || rawTurnIds.has(turnId)) {
      continue;
    }
    for (const item of Array.isArray(entity?.items) ? entity.items : []) {
      if (normalizeToken(item?.type) === "automaticapprovalreview") {
        overlays.push({ turnId, item });
      }
    }
  }
  return overlays;
}

// Approved reviews outside the projected tail are ordinary tool history, not
// something needing the user's attention; replaying them appends detached
// rows at the live tail. Denied/other outcomes stay visible everywhere
// because they may still need the user's review.
function isDetachedApprovedReview(status, turnId, projectedTurnIds) {
  return normalizeToken(status) === "approved" && !projectedTurnIds.has(turnId);
}

function reviewOverlayFacts(overlay) {
  const item = overlay?.item;
  const review = item?.review && typeof item.review === "object" ? item.review : item;
  const reviewId = readString(item?.reviewId)
    || readString(item?.id).replace(AUTO_APPROVAL_REVIEW_ITEM_ID_PREFIX, "");
  const status = readString(review?.status);
  if (!reviewId || !status || !item?.action) {
    return null;
  }
  return { item, review, reviewId, status };
}

function reviewOverlayFingerprint(status, item) {
  return createHash("sha256").update(JSON.stringify({ status, item })).digest("hex");
}

// Refreshes insertion order so the cache stays a bounded per-thread LRU.
// Returns false when the fingerprint is unchanged, so callers skip re-sending
// an overlay that was already delivered.
function rememberReviewOverlayFingerprint(fingerprints, reviewId, fingerprint) {
  if (fingerprints.get(reviewId) === fingerprint) {
    return false;
  }
  fingerprints.delete(reviewId);
  fingerprints.set(reviewId, fingerprint);
  while (fingerprints.size > MAX_NORMALIZED_REVIEW_FINGERPRINTS_PER_THREAD) {
    const oldestReviewId = fingerprints.keys().next().value;
    fingerprints.delete(oldestReviewId);
  }
  return true;
}

function reviewOverlayNotification(threadId, overlay, facts) {
  const { item, review, reviewId, status } = facts;
  return {
    method: normalizeToken(status) === "inprogress"
      ? "item/autoApprovalReview/started"
      : "item/autoApprovalReview/completed",
    params: {
      threadId,
      turnId: overlay.turnId,
      reviewId,
      targetItemId: readString(item.targetItemId) || null,
      startedAtMs: item.startedAtMs ?? null,
      completedAtMs: item.completedAtMs ?? null,
      decisionSource: readString(item.decisionSource)
        || readString(item?.event?.decision_source)
        || null,
      review: cloneJSON(review),
      action: cloneJSON(item.action),
      agntDesktopMirror: true,
      agntDesktopIpcMirror: true,
      agntGuardianRetrySupported: false,
      agntActionSource: DESKTOP_IPC_ACTION_SOURCE,
    },
  };
}

// Drains normalized-only guardian review overlays for threadId and replays
// each unseen one as a synthetic item/autoApprovalReview/* notification.
// Call this wherever an idle Desktop-mirrored thread's canonical history is
// (re)synced, so a thread that stays idle after opening still delivers
// review state that already happened.
function drainPendingReviewOverlays({
  threadId,
  rawState,
  liveTurns = [],
  fingerprintsByThreadId,
  sendApplicationResponse,
}) {
  const overlays = collectPendingReviewOverlays(rawState);
  if (overlays.length === 0) {
    return;
  }

  const projectedTurnIds = new Set(
    (Array.isArray(liveTurns) ? liveTurns : [])
      .map((turn) => readString(turn?.id) || readString(turn?.turnId) || readString(turn?.turn_id))
      .filter(Boolean)
  );
  const fingerprints = fingerprintsByThreadId.get(threadId) || new Map();
  for (const overlay of overlays) {
    const facts = reviewOverlayFacts(overlay);
    if (!facts) {
      continue;
    }
    if (isDetachedApprovedReview(facts.status, readString(overlay.turnId), projectedTurnIds)) {
      continue;
    }
    const fingerprint = reviewOverlayFingerprint(facts.status, facts.item);
    if (!rememberReviewOverlayFingerprint(fingerprints, facts.reviewId, fingerprint)) {
      continue;
    }
    sendApplicationResponse(JSON.stringify(reviewOverlayNotification(threadId, overlay, facts)));
  }
  fingerprintsByThreadId.set(threadId, fingerprints);
}

module.exports = {
  collectPendingReviewOverlays,
  drainPendingReviewOverlays,
};
