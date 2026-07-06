// FILE: bridge/contextual-user-items.js
// Purpose: Identifies injected local context that Codex stores as user items
//          but clients should not render as chat bubbles.
// Layer: Bridge support
// Exports: isContextualUserText, isUserRoleHistoryItem, historyItemUserText

function isContextualUserText(value) {
  const text = normalizeNonEmptyString(value);
  if (!text) {
    return false;
  }

  return text.startsWith("# AGENTS.md instructions for ")
    || text.startsWith("<environment_context>")
    || text.startsWith("<codex_internal_context ");
}

function isUserRoleHistoryItem(item) {
  if (!item || typeof item !== "object") {
    return false;
  }
  const type = normalizeHistoryItemToken(item.type);
  if (type === "usermessage") {
    return true;
  }
  return type === "message" && normalizeNonEmptyString(item.role).toLowerCase() === "user";
}

function historyItemUserText(item) {
  const direct = normalizeNonEmptyString(item?.text) || normalizeNonEmptyString(item?.message);
  if (direct) {
    return direct;
  }

  const content = Array.isArray(item?.content) ? item.content : [];
  return content
    .map((entry) => {
      if (typeof entry === "string") {
        return entry;
      }
      if (!entry || typeof entry !== "object") {
        return "";
      }
      return normalizeNonEmptyString(entry.text)
        || normalizeNonEmptyString(entry.input_text)
        || "";
    })
    .filter(Boolean)
    .join("\n");
}

function normalizeHistoryItemToken(value) {
  return normalizeNonEmptyString(value).toLowerCase().replace(/[\s_-]+/g, "");
}

function normalizeNonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

module.exports = {
  historyItemUserText,
  isContextualUserText,
  isUserRoleHistoryItem,
};
