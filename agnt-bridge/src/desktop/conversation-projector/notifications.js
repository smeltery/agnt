// FILE: notifications.js
// Purpose: Builds mobile live notifications from projected Desktop IPC conversation diffs.
// Layer: CLI helper
// Depends on: ../desktop-ipc-shared, ../desktop-ipc-projection-status, ./items

const {
  cloneJSON,
  normalizeToken,
  readString,
} = require("../desktop-ipc-shared");
const {
  isActiveTurnStatus,
  isTerminalItemState,
} = require("../desktop-ipc-projection-status");
const {
  assistantMessageText,
  commandOutput,
  fileChangeOutput,
  isAssistantMessageItem,
  isToolCallItem,
  itemIdOf,
  planText,
  textArray,
  toolCallOutput,
} = require("./items");

const DESKTOP_IPC_ACTION_SOURCE = "desktop-ipc-action-follower";
const MIRROR_TAG = {
  agntDesktopMirror: true,
  agntDesktopIpcMirror: true,
  agntActionSource: DESKTOP_IPC_ACTION_SOURCE,
};

function bootstrapNotifications(
  threadId,
  projection,
  { includeThreadStarted = true, includeAllActiveTurns = false } = {}
) {
  const notifications = includeThreadStarted && shouldEmitThreadStarted(projection.thread)
    ? [threadStartedNotification(projection.thread)]
    : [];
  const activeTurns = includeAllActiveTurns
    ? projection.turns.filter((turn) => isActiveTurnStatus(turn.status))
    : projection.activeTurnId
      ? projection.turns.filter((turn) => turn.id === projection.activeTurnId)
      : [];
  if (activeTurns.length === 0) {
    return notifications;
  }

  for (const activeTurn of activeTurns) {
    notifications.push(turnStartedNotification(threadId, activeTurn));
    for (const item of activeTurn.items) {
      notifications.push(itemStartedNotification(threadId, activeTurn.id, item));
      if (isTerminalItemState(item)) {
        notifications.push(itemCompletedNotification(threadId, activeTurn.id, item));
      }
    }
  }
  return notifications;
}

function shouldEmitThreadStarted(thread) {
  return Boolean(readString(thread.title)
    || readString(thread.name)
    || readString(thread.cwd)
    || readString(thread.preview)
    || (Array.isArray(thread.turns) && thread.turns.length > 0));
}

function diffProjections(threadId, previousProjection, nextProjection) {
  const notifications = [];

  notifications.push(...diffThreadMetadata(previousProjection.thread, nextProjection.thread));
  notifications.push(...diffTurnLifecycle(threadId, previousProjection, nextProjection));
  notifications.push(...diffTurnItems(threadId, previousProjection, nextProjection));

  return notifications;
}

function diffThreadMetadata(previousThread, nextThread) {
  const notifications = [];
  const previousRuntimeRevision = Number(previousThread.runtimeSettingsRevision) || 0;
  const nextRuntimeRevision = Number(nextThread.runtimeSettingsRevision) || 0;
  if (nextRuntimeRevision > previousRuntimeRevision) {
    notifications.push(threadStartedNotification(nextThread));
  }

  const previousTitle = readString(previousThread.title) || readString(previousThread.name);
  const nextTitle = readString(nextThread.title) || readString(nextThread.name);
  if (nextTitle && previousTitle !== nextTitle) {
    notifications.push(tagNotification({
      method: "thread/name/updated",
      params: {
        threadId: nextThread.id,
        threadName: nextTitle,
        name: nextTitle,
        title: nextTitle,
      },
    }));
  }

  if (JSON.stringify(previousThread.status || null) !== JSON.stringify(nextThread.status || null)) {
    notifications.push(tagNotification({
      method: "thread/status/changed",
      params: {
        threadId: nextThread.id,
        status: cloneJSON(nextThread.status || null),
      },
    }));
  }

  if (nextThread.tokenUsage != null
    && JSON.stringify(previousThread.tokenUsage || null) !== JSON.stringify(nextThread.tokenUsage)) {
    notifications.push(tagNotification({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: nextThread.id,
        usage: cloneJSON(nextThread.tokenUsage),
        tokenUsage: cloneJSON(nextThread.tokenUsage),
      },
    }));
  }

  return notifications;
}

function diffTurnLifecycle(threadId, previousProjection, nextProjection) {
  const notifications = [];
  const previousActive = previousProjection.activeTurnId || null;
  const nextActive = nextProjection.activeTurnId || null;
  if (!previousActive && nextActive) {
    const nextTurn = findTurn(nextProjection.turns, nextActive);
    if (nextTurn) {
      notifications.push(turnStartedNotification(threadId, nextTurn));
    }
    return notifications;
  }
  if (previousActive && !nextActive) {
    const completedTurn = findTurn(nextProjection.turns, previousActive)
      || findTurn(previousProjection.turns, previousActive);
    if (completedTurn) {
      notifications.push(turnCompletedNotification(threadId, completedTurn));
    }
    return notifications;
  }
  if (previousActive && nextActive && previousActive !== nextActive) {
    const completedTurn = findTurn(nextProjection.turns, previousActive)
      || findTurn(previousProjection.turns, previousActive);
    const startedTurn = findTurn(nextProjection.turns, nextActive);
    if (completedTurn) {
      notifications.push(turnCompletedNotification(threadId, completedTurn));
    }
    if (startedTurn) {
      notifications.push(turnStartedNotification(threadId, startedTurn));
    }
  }
  return notifications;
}

function diffTurnItems(threadId, previousProjection, nextProjection) {
  const notifications = [];
  const previousTurnsById = new Map(previousProjection.turns.map((turn) => [turn.id, turn]));

  for (const nextTurn of nextProjection.turns) {
    const previousTurn = previousTurnsById.get(nextTurn.id) || null;
    if (previousTurn === nextTurn) {
      continue;
    }
    const previousItemsById = new Map((previousTurn?.items || []).map((item) => [itemIdOf(item), item]));
    const isActiveTurn = nextProjection.activeTurnId === nextTurn.id;

    for (const nextItem of nextTurn.items) {
      const itemId = itemIdOf(nextItem);
      if (!itemId) {
        continue;
      }
      const previousItem = previousItemsById.get(itemId) || null;
      if (!previousItem) {
        notifications.push(itemStartedNotification(threadId, nextTurn.id, nextItem));
        if (!isActiveTurn || isTerminalItemState(nextItem)) {
          notifications.push(itemCompletedNotification(threadId, nextTurn.id, nextItem));
        }
        continue;
      }
      if (previousItem === nextItem
        || JSON.stringify(previousItem) === JSON.stringify(nextItem)) {
        continue;
      }
      if (!isActiveTurn) {
        notifications.push(itemCompletedNotification(threadId, nextTurn.id, nextItem));
        continue;
      }
      notifications.push(...diffItem(threadId, nextTurn.id, previousItem, nextItem));
    }
  }

  return notifications;
}

function diffItem(threadId, turnId, previousItem, nextItem) {
  const itemId = itemIdOf(nextItem);
  const itemType = normalizeToken(nextItem.type);
  const snapshot = snapshotItem(previousItem);
  if (isAssistantMessageItem(nextItem)) {
    const previousText = assistantMessageText(previousItem);
    const nextText = assistantMessageText(nextItem);
    const delta = appendedDelta(previousText, nextText, snapshot.agentTextLen);
    if (delta) {
      return [deltaNotification("item/agentMessage/delta", threadId, turnId, itemId, delta)];
    }
    return [itemCompletedNotification(threadId, turnId, nextItem)];
  }

  if (itemType === "plan" || itemType === "todolist") {
    const previousText = planText(previousItem);
    const nextText = planText(nextItem);
    const delta = appendedDelta(previousText, nextText, snapshot.planTextLen);
    if (delta) {
      return [deltaNotification("item/plan/delta", threadId, turnId, itemId, delta)];
    }
    return [itemCompletedNotification(threadId, turnId, nextItem)];
  }

  if (itemType === "reasoning") {
    const reasoning = reasoningDeltaNotifications(threadId, turnId, itemId, previousItem, nextItem, snapshot);
    return reasoning.length > 0 ? reasoning : [itemCompletedNotification(threadId, turnId, nextItem)];
  }

  if (itemType === "commandexecution") {
    if (normalizeToken(previousItem.status) !== normalizeToken(nextItem.status)) {
      return [itemCompletedNotification(threadId, turnId, nextItem)];
    }
    const delta = appendedDelta(commandOutput(previousItem), commandOutput(nextItem), snapshot.commandOutputLen);
    if (delta) {
      return [deltaNotification("item/commandExecution/outputDelta", threadId, turnId, itemId, delta)];
    }
    return [itemCompletedNotification(threadId, turnId, nextItem)];
  }

  if (itemType === "filechange") {
    const delta = appendedDelta(fileChangeOutput(previousItem), fileChangeOutput(nextItem), snapshot.fileOutputLen);
    if (delta) {
      return [deltaNotification("item/fileChange/outputDelta", threadId, turnId, itemId, delta)];
    }
    return [itemCompletedNotification(threadId, turnId, nextItem)];
  }

  if (isToolCallItem(nextItem)) {
    const delta = appendedDelta(toolCallOutput(previousItem), toolCallOutput(nextItem), snapshot.toolOutputLen);
    if (delta) {
      return [deltaNotification("item/toolCall/outputDelta", threadId, turnId, itemId, delta, {
        item: cloneJSON(nextItem),
      })];
    }
  }

  return [itemCompletedNotification(threadId, turnId, nextItem)];
}

function reasoningDeltaNotifications(threadId, turnId, itemId, previousItem, nextItem, snapshot) {
  const notifications = [];
  const previousSummary = textArray(previousItem.summary);
  const nextSummary = textArray(nextItem.summary);
  const previousContent = textArray(previousItem.content);
  const nextContent = textArray(nextItem.content);
  const summaryLens = Array.isArray(snapshot.reasoningSummaryLens) ? snapshot.reasoningSummaryLens : [];
  const contentLens = Array.isArray(snapshot.reasoningContentLens) ? snapshot.reasoningContentLens : [];

  for (let index = 0; index < nextSummary.length; index += 1) {
    if (index >= previousSummary.length) {
      notifications.push(tagNotification({
        method: "item/reasoning/summaryPartAdded",
        params: {
          threadId,
          turnId,
          itemId,
          summaryIndex: index,
        },
      }));
      if (nextSummary[index]) {
        notifications.push(deltaNotification(
          "item/reasoning/summaryTextDelta",
          threadId,
          turnId,
          itemId,
          nextSummary[index],
          { summaryIndex: index }
        ));
      }
      continue;
    }
    const delta = appendedDelta(previousSummary[index], nextSummary[index], summaryLens[index]);
    if (delta) {
      notifications.push(deltaNotification(
        "item/reasoning/summaryTextDelta",
        threadId,
        turnId,
        itemId,
        delta,
        { summaryIndex: index }
      ));
    }
  }

  for (let index = 0; index < nextContent.length; index += 1) {
    const previousText = previousContent[index] || "";
    const delta = appendedDelta(previousText, nextContent[index], contentLens[index]);
    if (delta) {
      notifications.push(deltaNotification(
        "item/reasoning/textDelta",
        threadId,
        turnId,
        itemId,
        delta,
        { contentIndex: index }
      ));
    }
  }

  return notifications;
}

function threadStartedNotification(thread) {
  return tagNotification({
    method: "thread/started",
    params: {
      threadId: thread.id,
      thread: cloneJSON(thread),
    },
  });
}

function turnStartedNotification(threadId, turn) {
  return tagNotification({
    method: "turn/started",
    params: {
      threadId,
      turnId: turn.id,
      turn: cloneJSON(turn),
    },
  });
}

function turnCompletedNotification(threadId, turn) {
  return tagNotification({
    method: "turn/completed",
    params: {
      threadId,
      turnId: turn.id,
      turn: cloneJSON(turn),
      status: turn.status,
      error: cloneJSON(turn.error || null),
    },
  });
}

function itemStartedNotification(threadId, turnId, item) {
  return tagNotification({
    method: "item/started",
    params: {
      threadId,
      turnId,
      itemId: itemIdOf(item),
      item: cloneJSON(item),
    },
  });
}

function itemCompletedNotification(threadId, turnId, item) {
  return tagNotification({
    method: "item/completed",
    params: {
      threadId,
      turnId,
      itemId: itemIdOf(item),
      item: cloneJSON(item),
    },
  });
}

function deltaNotification(method, threadId, turnId, itemId, delta, extraParams = {}) {
  return tagNotification({
    method,
    params: {
      threadId,
      turnId,
      itemId,
      delta,
      ...extraParams,
    },
  });
}

function tagNotification(notification) {
  return {
    method: notification.method,
    params: {
      ...notification.params,
      ...MIRROR_TAG,
    },
  };
}

function snapshotItem(item) {
  return {
    agentTextLen: assistantMessageText(item).length,
    planTextLen: planText(item).length,
    reasoningSummaryLens: textArray(item.summary).map((entry) => entry.length),
    reasoningContentLens: textArray(item.content).map((entry) => entry.length),
    commandOutputLen: commandOutput(item).length,
    fileOutputLen: fileChangeOutput(item).length,
    toolOutputLen: toolCallOutput(item).length,
  };
}

function appendedDelta(previousText, nextText, snapshotLength) {
  const normalizedPrevious = typeof previousText === "string" ? previousText : "";
  const normalizedNext = typeof nextText === "string" ? nextText : "";
  const previousLength = Number.isInteger(snapshotLength) ? snapshotLength : normalizedPrevious.length;
  const prefix = normalizedPrevious.slice(0, Math.min(previousLength, normalizedPrevious.length));
  if (!normalizedNext.startsWith(prefix) || normalizedNext.length <= previousLength) {
    return "";
  }
  return normalizedNext.slice(previousLength);
}

function findTurn(turns, turnId) {
  return turns.find((turn) => turn.id === turnId) || null;
}

module.exports = {
  bootstrapNotifications,
  diffProjections,
  threadStartedNotification,
};
