const { createNoopDesktopRefresher } = require("./lifecycle");
const {
  buildEmergencySingleTurnResponse,
  buildEmptyTurnsListResponse,
  buildLargestSafeTurnsListResponse,
  compactEmergencySingleTurnForRelay,
  fetchAdaptiveThreadTurnsListForRelay,
  isEmptyTurnsListResponse,
  maybeBuildJsonlThreadTurnsListFallback,
  unwrapAppServerPayloadResult,
} = require("./turns-list-pager");
const {
  buildHeartbeatBridgeStatus,
  hasRelayConnectionGoneStale,
} = require("./relay-heartbeat");
const {
  isRelayBoundServerRequestMethod,
  normalizeRelayBoundJsonRpcMessage,
} = require("./jsonrpc-normalizer");
const { sanitizeLiveGeneratedImageMessageForRelay } = require("./relay-image-sanitizer");
const { sanitizeThreadHistoryImagesForRelay } = require("./relay-payload-pipeline");
const { persistBridgePreferences } = require("./bridge-preferences");
const { disableUnsupportedReasoningSummaryForTurnStart } = require("./turn-start-normalizer");

module.exports = {
  buildEmergencySingleTurnResponse,
  buildEmptyTurnsListResponse,
  buildHeartbeatBridgeStatus,
  buildLargestSafeTurnsListResponse,
  compactEmergencySingleTurnForRelay,
  createNoopDesktopRefresher,
  disableUnsupportedReasoningSummaryForTurnStart,
  fetchAdaptiveThreadTurnsListForRelay,
  hasRelayConnectionGoneStale,
  isEmptyTurnsListResponse,
  isRelayBoundServerRequestMethod,
  maybeBuildJsonlThreadTurnsListFallback,
  normalizeRelayBoundJsonRpcMessage,
  persistBridgePreferences,
  sanitizeLiveGeneratedImageMessageForRelay,
  sanitizeThreadHistoryImagesForRelay,
  unwrapAppServerPayloadResult,
};
