// FILE: items.js
// Purpose: Projects Desktop IPC items and compares projected turn identity.
// Layer: CLI helper
// Depends on: ../desktop-ipc-shared

const {
  cloneJSON,
  normalizeToken,
  readString,
  readText,
  sanitizeUserInputEntries: sanitizeSharedUserInputEntries,
} = require("../desktop-ipc-shared");

const SKIPPED_ITEM = Symbol("agnt-skipped-item");

function hasSynthesizedTurnIds(projection) {
  return projection.turns.some((turn) => readString(turn.id).startsWith("ipc-turn-"));
}

function desktopTurnsShareLogicalIdentity(previousTurn, nextTurn) {
  return desktopTurnLogicalIdentityScore(previousTurn, nextTurn) > 0;
}

function desktopTurnLogicalIdentityScore(previousTurn, nextTurn) {
  if (!previousTurn || !nextTurn) {
    return 0;
  }

  const previousStableItemIDs = stableTurnItemIDs(previousTurn);
  const nextStableItemIDs = stableTurnItemIDs(nextTurn);
  for (const itemID of previousStableItemIDs) {
    if (nextStableItemIDs.has(itemID)) {
      return 2;
    }
  }

  const previousPrompt = turnPromptSignature(previousTurn);
  const nextPrompt = turnPromptSignature(nextTurn);
  const previousStart = turnStartIdentity(previousTurn);
  const nextStart = turnStartIdentity(nextTurn);
  return previousPrompt !== ""
    && previousPrompt === nextPrompt
    && previousStart !== ""
    && previousStart === nextStart
    ? 1
    : 0;
}

function matchDesktopTurnIdentityContinuities(previousTurns, nextTurns) {
  const previousById = new Map(previousTurns.map((turn) => [readString(turn?.id), turn]));
  const nextById = new Map(nextTurns.map((turn) => [readString(turn?.id), turn]));
  const previousTurnIds = new Set();
  const nextTurnIds = new Set();
  const removedSyntheticTurns = previousTurns.filter((turn) => {
    const turnID = readString(turn?.id);
    return turnID && !nextById.has(turnID) && turnID.startsWith("ipc-turn-");
  });
  const addedCanonicalTurns = nextTurns.filter((turn) => {
    const turnID = readString(turn?.id);
    return turnID && !previousById.has(turnID) && !turnID.startsWith("ipc-turn-");
  });

  function applyMaximumMatchesForScore(requiredScore) {
    const nextOwnerByID = new Map();

    function tryAssign(previousEntry, visitedNextIDs) {
      for (const nextEntry of addedCanonicalTurns) {
        const nextID = readString(nextEntry?.id);
        if (nextTurnIds.has(nextID) || visitedNextIDs.has(nextID)) {
          continue;
        }
        const score = desktopTurnLogicalIdentityScore(
          previousEntry?.turn || previousEntry,
          nextEntry?.turn || nextEntry
        );
        if (score !== requiredScore) {
          continue;
        }
        visitedNextIDs.add(nextID);
        const currentOwner = nextOwnerByID.get(nextID);
        if (!currentOwner || tryAssign(currentOwner, visitedNextIDs)) {
          nextOwnerByID.set(nextID, previousEntry);
          return true;
        }
      }
      return false;
    }

    for (const previousEntry of removedSyntheticTurns) {
      const previousID = readString(previousEntry?.id);
      if (!previousTurnIds.has(previousID)) {
        tryAssign(previousEntry, new Set());
      }
    }
    for (const [nextID, previousEntry] of nextOwnerByID) {
      previousTurnIds.add(readString(previousEntry?.id));
      nextTurnIds.add(nextID);
    }
  }

  applyMaximumMatchesForScore(2);
  applyMaximumMatchesForScore(1);

  return { previousTurnIds, nextTurnIds };
}

function stableTurnItemIDs(turn) {
  return new Set((Array.isArray(turn?.items) ? turn.items : []).flatMap((item) => {
    if (normalizeToken(item?.type) === "usermessage") {
      return [];
    }
    const itemID = itemIdOf(item);
    return itemID ? [itemID] : [];
  }));
}

function turnPromptSignature(turn) {
  const paramsInput = Array.isArray(turn?.params?.input) ? turn.params.input : [];
  let prompt = renderUserInputText(paramsInput);
  if (!prompt) {
    const userItem = (Array.isArray(turn?.items) ? turn.items : []).find((item) => (
      normalizeToken(item?.type) === "usermessage"
    ));
    prompt = renderUserInputText(userItem?.content);
  }
  return prompt.trim().replace(/\s+/g, " ");
}

function turnStartIdentity(turn) {
  const value = turn?.startedAt
    ?? turn?.started_at
    ?? turn?.turnStartedAtMs
    ?? turn?.turn_started_at_ms;
  if (typeof value === "number" && Number.isFinite(value)) {
    return `number:${value}`;
  }
  const text = readString(value);
  return text ? `text:${text}` : "";
}

function threadPreview(turns) {
  for (const turn of turns) {
    for (const item of turn.items) {
      if (normalizeToken(item.type) !== "usermessage") {
        continue;
      }
      const text = renderUserInputText(item.content).trim();
      if (text) {
        return stripRequestWrapper(text);
      }
    }
  }
  return "";
}

function renderUserInputText(content) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((entry) => {
      if (typeof entry === "string") {
        return entry;
      }
      if (!entry || typeof entry !== "object") {
        return "";
      }
      return readString(entry.text) || readString(entry.content) || "";
    })
    .filter(Boolean)
    .join("\n");
}

function stripRequestWrapper(text) {
  const marker = "## My request for Codex:";
  return text.includes(marker) ? text.split(marker).at(-1).trim() : text.trim();
}

function sameUserInput(content, paramsInput) {
  return JSON.stringify(content || []) === JSON.stringify(paramsInput || []);
}

function sameVisibleUserText(content, visibleInput) {
  const itemText = renderUserInputText(sanitizeUserInputEntries(content)).trim();
  const paramsText = renderUserInputText(visibleInput).trim();
  return Boolean(itemText) && itemText === paramsText;
}

function sanitizeUserInputEntries(entries) {
  return sanitizeSharedUserInputEntries(entries);
}

function projectItemForMobile(item, itemType = normalizeToken(item?.type)) {
  if (itemType === "usermessage") {
    const visibleContent = sanitizeUserInputEntries(
      Array.isArray(item?.content) ? item.content : []
    );
    if (visibleContent.length === 0) {
      return null;
    }
    const projected = cloneJSON(item);
    projected.content = cloneJSON(visibleContent);
    return projected;
  }

  const projected = cloneJSON(item);
  if (!isGenericToolCallItemType(itemType)) {
    return projected;
  }

  projected.type = "toolCall";
  if (!projected.agntDesktopIpcItemType) {
    projected.agntDesktopIpcItemType = readString(item?.type) || itemType;
  }
  return projected;
}

function isSupportedItemType(type) {
  return type === "usermessage"
    || type === "hookprompt"
    || type === "agentmessage"
    || type === "assistantmessage"
    || type === "message"
    || type === "plan"
    || type === "todolist"
    || type === "reasoning"
    || type === "commandexecution"
    || type === "filechange"
    || type === "toolcall"
    || type === "mcptoolcall"
    || type === "dynamictoolcall"
    || type === "collabagenttoolcall"
    || type === "collabtoolcall"
    || type === "websearch"
    || type === "imageview"
    || type === "imagegeneration"
    || type === "enteredreviewmode"
    || type === "exitedreviewmode"
    || type === "contextcompaction";
}

function isAssistantMessageItem(item) {
  const type = normalizeToken(item?.type);
  if (type === "agentmessage" || type === "assistantmessage") {
    return true;
  }
  return type === "message" && normalizeToken(item?.role) !== "user";
}

function isToolCallItem(item) {
  const type = normalizeToken(item?.type);
  return isGenericToolCallItemType(type)
    || type === "collabagenttoolcall"
    || type === "collabtoolcall";
}

function isGenericToolCallItemType(type) {
  return type === "toolcall"
    || type === "mcptoolcall"
    || type === "dynamictoolcall"
    || type === "websearch";
}

function assistantMessageText(item) {
  if (!isAssistantMessageItem(item)) {
    return "";
  }
  return readText(item.text)
    || readText(item.message)
    || renderContentText(item.content);
}

function planText(item) {
  return readText(item.text)
    || renderContentText(item.plan)
    || renderContentText(item.content);
}

function commandOutput(item) {
  return readText(item.aggregatedOutput)
    || readText(item.aggregated_output)
    || readText(item.output)
    || readText(item.stdout)
    || "";
}

function fileChangeOutput(item) {
  return readText(item.aggregatedOutput)
    || readText(item.aggregated_output)
    || readText(item.output)
    || readText(item.diff)
    || readText(item.patch)
    || "";
}

function toolCallOutput(item) {
  return readText(item.output)
    || readText(item.result)
    || readText(item.response)
    || renderContentText(item.result?.content)
    || renderContentText(item.contentItems)
    || renderContentText(item.content_items)
    || renderContentText(item.content)
    || "";
}

function textArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => {
    if (typeof entry === "string") {
      return entry;
    }
    if (!entry || typeof entry !== "object") {
      return "";
    }
    return readText(entry.text) || readText(entry.content) || "";
  });
}

function renderContentText(value) {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    return "";
  }
  return value
    .map((entry) => {
      if (typeof entry === "string") {
        return entry;
      }
      if (!entry || typeof entry !== "object") {
        return "";
      }
      return readText(entry.text)
        || readText(entry.content)
        || readText(entry?.data?.text)
        || readText(entry?.file?.content);
    })
    .filter((entry) => entry !== "")
    .join("");
}

function itemIdOf(item) {
  return readString(item?.id) || readString(item?.itemId) || readString(item?.item_id);
}

module.exports = {
  SKIPPED_ITEM,
  assistantMessageText,
  commandOutput,
  desktopTurnsShareLogicalIdentity,
  fileChangeOutput,
  hasSynthesizedTurnIds,
  isAssistantMessageItem,
  isSupportedItemType,
  isToolCallItem,
  itemIdOf,
  matchDesktopTurnIdentityContinuities,
  planText,
  projectItemForMobile,
  renderUserInputText,
  sameUserInput,
  sameVisibleUserText,
  sanitizeUserInputEntries,
  textArray,
  threadPreview,
  toolCallOutput,
};
