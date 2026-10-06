// FILE: item-normalization.js
// Purpose: Normalizes Desktop conversation turn items and user prompt payloads.
// Layer: CLI helper
// Exports: turn item/user-message normalization helpers
// Depends on: ../desktop-ipc-shared

const {
  cloneJSON,
  isContextualUserText,
  isUserRoleItem: isUserMessageItem,
  normalizeToken,
  readString,
  visibleUserPromptText,
} = require("../desktop-ipc-shared");

const PRE_PROMPT_META_ITEM_TYPES = new Set([
  "automaticapprovalreview",
  "forkedfromconversation",
  "modelchanged",
  "modelrerouted",
  "personalitychanged",
  "remotetaskcreated",
  "worktreeinit",
]);

function turnHasUserMessageItem(turn) {
  return turn.items.some((item) => isUserMessageItem(item));
}

function extractUserText(entries) {
  if (typeof entries === "string") {
    return entries.trim();
  }
  if (!Array.isArray(entries)) {
    return "";
  }
  return entries
    .map((entry) => {
      if (typeof entry === "string") {
        return entry;
      }
      if (!entry || typeof entry !== "object") {
        return "";
      }
      return typeof entry.text === "string" ? entry.text : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function sanitizeUserInputEntries(entries) {
  if (!Array.isArray(entries)) {
    return [];
  }
  const sanitized = [];
  for (const entry of entries) {
    if (typeof entry === "string") {
      const visible = visibleUserPromptText(entry);
      if (visible) {
        sanitized.push(visible);
      }
      continue;
    }
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const text = typeof entry.text === "string" ? entry.text : "";
    if (!text) {
      sanitized.push(cloneJSON(entry));
      continue;
    }
    const visible = visibleUserPromptText(text);
    if (!visible) {
      continue;
    }
    sanitized.push(visible === text ? cloneJSON(entry) : {
      ...cloneJSON(entry),
      text: visible,
    });
  }
  return normalizeDesktopInputEntries(sanitized);
}

function normalizeDesktopInputEntries(entries) {
  if (!Array.isArray(entries)) {
    return [];
  }
  return entries.map((entry) => {
    if (!entry || typeof entry !== "object" || entry.type !== "text"
      || Array.isArray(entry.text_elements)) {
      return entry;
    }
    return { ...entry, text_elements: [] };
  });
}

function sanitizeUserMessageItem(item) {
  if (!isUserMessageItem(item)) {
    return item;
  }
  const rawText = extractUserText(item?.content);
  const sanitizedContent = sanitizeUserInputEntries(Array.isArray(item?.content) ? item.content : []);
  if (rawText && sanitizedContent.length === 0) {
    return null;
  }
  if (!Array.isArray(item?.content)) {
    return cloneJSON(item);
  }
  return {
    ...cloneJSON(item),
    content: sanitizedContent,
  };
}

function normalizeDesktopItemCompatibility(item) {
  if (!item || typeof item !== "object") return item;
  if (item.type === "userMessage" || item.type === "steeringUserMessage") {
    const key = item.type === "userMessage" ? "content" : "input";
    return { ...item, [key]: normalizeDesktopInputEntries(item[key]) };
  }
  if (normalizeToken(item.type) !== "collabagenttoolcall") return item;

  const receiverThreads = Array.isArray(item.receiverThreads)
    ? item.receiverThreads
    : [];
  const receiverThreadIds = Array.isArray(item.receiverThreadIds)
    ? item.receiverThreadIds.map(readString).filter(Boolean)
    : receiverThreads.map((entry) => readString(entry?.threadId)).filter(Boolean);
  if (Array.isArray(item.receiverThreads) && Array.isArray(item.receiverThreadIds)) {
    return item;
  }

  return {
    ...item,
    receiverThreadIds,
    receiverThreads: Array.isArray(item.receiverThreads)
      ? receiverThreads
      : receiverThreadIds.map((threadId) => ({ threadId })),
  };
}

function isInitialPromptUserMessageItem(turn, item) {
  if (!isUserMessageItem(item)) {
    return false;
  }
  const promptText = extractUserText(turn?.params?.input);
  if (!promptText) {
    return false;
  }
  return extractUserText(item?.content) === promptText;
}

function isContextualUserMessageItem(item) {
  if (!isUserMessageItem(item)) {
    return false;
  }
  const text = extractUserText(item?.content);
  return Boolean(text) && isContextualUserText(text);
}

function normalizeTurnInitialPrompt(turn) {
  if (!turn || !Array.isArray(turn.items)) {
    return;
  }
  if (Array.isArray(turn.params?.input)) {
    turn.params = {
      ...turn.params,
      input: sanitizeUserInputEntries(turn.params.input),
    };
  }
  const promptText = extractUserText(turn?.params?.input);
  for (let index = 0; index < turn.items.length; index += 1) {
    let item = turn.items[index];
    const sanitizedItem = sanitizeUserMessageItem(item);
    if (!sanitizedItem) {
      turn.items.splice(index, 1);
      index -= 1;
      continue;
    }
    if (sanitizedItem !== item) {
      turn.items[index] = sanitizedItem;
      item = sanitizedItem;
    }
    // Injected context user items sit before the real prompt in persisted
    // history; strip them so they are never adopted as the prompt bubble.
    if (isContextualUserMessageItem(item)) {
      turn.items.splice(index, 1);
      index -= 1;
      continue;
    }
    if (isUserMessageItem(item)) {
      const itemText = extractUserText(item?.content);
      if (!itemText) {
        return;
      }
      if (!promptText) {
        if (adoptInitialPromptUserMessage(turn, item)) {
          turn.items.splice(index, 1);
        }
        return;
      }
      if (itemText === promptText) {
        turn.items.splice(index, 1);
      }
      return;
    }
    if (!PRE_PROMPT_META_ITEM_TYPES.has(normalizeToken(item?.type))) {
      return;
    }
  }
}

function userMessageContentFromTurnInput(entry) {
  if (typeof entry === "string") {
    const text = readString(entry);
    return text ? { type: "text", text, text_elements: [] } : null;
  }
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const type = normalizeToken(entry.type);
  if (type === "inputtext" || type === "text") {
    return {
      ...cloneJSON(entry),
      type: "text",
      text: typeof entry.text === "string" ? entry.text : "",
      text_elements: Array.isArray(entry.text_elements) ? cloneJSON(entry.text_elements) : [],
    };
  }
  return cloneJSON(entry);
}


function adoptInitialPromptUserMessage(turn, item) {
  if (!isUserMessageItem(item) || !Array.isArray(item?.content)) {
    return false;
  }
  const input = item.content
    .map(userMessageContentFromTurnInput)
    .filter(Boolean);
  if (input.length === 0) {
    return false;
  }
  turn.params = {
    ...turn.params,
    input,
  };
  return true;
}

module.exports = {
  normalizeDesktopInputEntries,
  adoptInitialPromptUserMessage,
  extractUserText,
  isInitialPromptUserMessageItem,
  normalizeDesktopItemCompatibility,
  normalizeTurnInitialPrompt,
  sanitizeUserMessageItem,
  turnHasUserMessageItem,
};
