// FILE: conversation-compatibility.js
// Purpose: Mirror legacy Desktop conversation turns into the canonical history graph.
// Layer: CLI helper
// Depends on: ../desktop-ipc-shared

const {
  cloneJSON,
  normalizeToken,
  readString,
} = require("../desktop-ipc-shared");

// Desktop moved rendered history to a canonical entity graph. It still accepts
// legacy turns during normalization, but unified-timeline selectors now assume
// the graph and several nested collections exist. Keep mutable legacy turns for
// app-server event handling, and mirror them into the current Desktop shape
// before every stream broadcast.
function synchronizeDesktopConversationCompatibility(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    return state;
  }

  const turns = Array.isArray(state.turns) ? state.turns : [];
  const entries = [];
  const entitiesByKey = {};
  for (const turn of turns) {
    const turnId = readString(turn?.turnId) || readString(turn?.id);
    if (!turnId) {
      continue;
    }
    turn.params = normalizeTurnParamsCompatibility(turn.params, {
      cwd: readString(turn.params?.cwd) || readString(state.cwd),
    });
    turn.items = Array.isArray(turn.items) ? turn.items : [];
    turn.hookRuns = Array.isArray(turn.hookRuns) ? turn.hookRuns : [];
    const key = `turn:${turnId}`;
    entries.push({ key, value: key });
    const { id: _legacyId, ...canonicalTurn } = turn;
    entitiesByKey[key] = {
      ...canonicalTurn,
      turnId,
    };
  }

  const islandId = "tail:0";
  state.turnHistory = {
    kind: "canonical",
    history: {
      entitiesByKey,
      generation: 0,
      isComplete: true,
      islands: [{
        id: islandId,
        entries,
        olderBoundary: {
          status: "exhausted",
          boundaryId: `${islandId}:older`,
        },
        newerBoundary: {
          status: "exhausted",
          boundaryId: `${islandId}:newer`,
        },
      }],
    },
  };
  state.turnsPagination = {
    olderCursor: null,
    oldestLoadedTurnId: readString(turns[0]?.turnId) || readString(turns[0]?.id) || null,
    isLoadingOlder: false,
    hasLoadedOldest: true,
  };

  const latestParams = [...turns]
    .reverse()
    .map((turn) => turn?.params)
    .find((params) => params && typeof params === "object") || null;
  const sandboxPolicy = normalizeSandboxPolicyCompatibility(
    latestParams?.sandboxPolicy || state.currentPermissions?.sandboxPolicy
  );
  if (sandboxPolicy) {
    const runtimeWorkspaceRoots = Array.isArray(latestParams?.runtimeWorkspaceRoots)
      ? cloneJSON(latestParams.runtimeWorkspaceRoots)
      : Array.isArray(state.currentPermissions?.runtimeWorkspaceRoots)
        ? cloneJSON(state.currentPermissions.runtimeWorkspaceRoots)
        : [];
    state.currentPermissions = {
      activePermissionProfile: cloneJSON(
        latestParams?.activePermissionProfile
          ?? state.currentPermissions?.activePermissionProfile
          ?? permissionProfileFromId(latestParams?.permissions)
      ),
      approvalPolicy: latestParams?.approvalPolicy
        ?? state.currentPermissions?.approvalPolicy
        ?? "on-request",
      approvalsReviewer: latestParams?.approvalsReviewer
        ?? state.currentPermissions?.approvalsReviewer
        ?? "user",
      runtimeWorkspaceRoots,
      sandboxPolicy,
    };
  }

  state.recencyAt = Number.isFinite(state.recencyAt) ? state.recencyAt : state.updatedAt;
  state.source ||= "vscode";
  state.threadSource ||= "user";
  state.historyMode ||= "legacy";
  state.mode ||= "default";
  state.threadStartKind ||= "default";
  state.modelProvider ||= "openai";
  state.latestThreadSettings = {
    cwd: readString(latestParams?.cwd) || readString(state.cwd) || null,
    approvalPolicy: latestParams?.approvalPolicy ?? state.currentPermissions?.approvalPolicy ?? null,
    approvalsReviewer: latestParams?.approvalsReviewer
      ?? state.currentPermissions?.approvalsReviewer
      ?? null,
    ...(sandboxPolicy ? { sandboxPolicy } : {}),
    activePermissionProfile: cloneJSON(state.currentPermissions?.activePermissionProfile ?? null),
    model: readString(state.latestThreadSettings?.model)
      || readString(latestParams?.model)
      || readString(state.latestModel)
      || null,
    modelProvider: readString(state.latestThreadSettings?.modelProvider)
      || readString(state.modelProvider)
      || "openai",
    serviceTier: readString(state.latestThreadSettings?.serviceTier)
      || readString(latestParams?.serviceTier)
      || readString(state.latestServiceTier)
      || null,
    effort: state.latestThreadSettings?.effort
      ?? latestParams?.effort
      ?? state.latestReasoningEffort
      ?? null,
    summary: latestParams?.summary ?? state.latestThreadSettings?.summary ?? "none",
    collaborationMode: cloneJSON(
      state.latestThreadSettings?.collaborationMode
        || latestParams?.collaborationMode
        || state.latestCollaborationMode
        || null
    ),
    multiAgentMode: latestParams?.multiAgentMode
      ?? state.latestThreadSettings?.multiAgentMode
      ?? null,
    personality: latestParams?.personality
      ?? state.latestThreadSettings?.personality
      ?? null,
  };
  return state;
}

function normalizeTurnParamsCompatibility(params, { cwd = "" } = {}) {
  const normalized = params && typeof params === "object" && !Array.isArray(params)
    ? params
    : {};
  normalized.input = Array.isArray(normalized.input) ? normalized.input : [];
  normalized.attachments = Array.isArray(normalized.attachments) ? normalized.attachments : [];
  normalized.cwd = readString(normalized.cwd) || readString(cwd) || null;
  normalized.summary ??= "none";
  normalized.personality ??= null;
  normalized.outputSchema ??= null;
  normalized.collaborationMode ??= null;
  const sandboxPolicy = normalizeSandboxPolicyCompatibility(normalized.sandboxPolicy);
  if (sandboxPolicy) {
    normalized.sandboxPolicy = sandboxPolicy;
  }
  return normalized;
}

function normalizeSandboxPolicyCompatibility(policy) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    return null;
  }
  const normalized = cloneJSON(policy);
  if (normalizeToken(normalized.type) === "workspacewrite") {
    normalized.type = "workspaceWrite";
    normalized.writableRoots = Array.isArray(normalized.writableRoots)
      ? normalized.writableRoots
      : [];
    normalized.excludeSlashTmp = Boolean(normalized.excludeSlashTmp);
    normalized.excludeTmpdirEnvVar = Boolean(normalized.excludeTmpdirEnvVar);
    normalized.networkAccess = Boolean(normalized.networkAccess);
  }
  if (normalizeToken(normalized.type) === "readonly") {
    normalized.type = "readOnly";
    normalized.networkAccess = Boolean(normalized.networkAccess);
  }
  return normalized;
}

function permissionProfileFromId(value) {
  const id = readString(value);
  return id ? { id, extends: null } : null;
}

module.exports = {
  normalizeTurnParamsCompatibility,
  synchronizeDesktopConversationCompatibility,
};
