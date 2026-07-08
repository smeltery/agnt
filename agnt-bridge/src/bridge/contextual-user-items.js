// FILE: bridge/contextual-user-items.js
// Purpose: Identifies injected local context that Codex stores as user items
//          but clients should not render as chat bubbles.
// Layer: Bridge support
// Exports: isContextualUserText, isUserRoleHistoryItem, historyItemUserText,
//          visibleUserPromptText

const {
  isContextualUserText,
  isUserRoleItem,
  readUserItemText,
  sanitizeUserRoleItem,
  visibleUserPromptText,
} = require("../desktop/desktop-ipc-shared");

function isUserRoleHistoryItem(item) {
  return isUserRoleItem(item);
}

function historyItemUserText(item) {
  return readUserItemText(item);
}

module.exports = {
  historyItemUserText,
  isContextualUserText,
  isUserRoleHistoryItem,
  sanitizeUserRoleItem,
  visibleUserPromptText,
};
