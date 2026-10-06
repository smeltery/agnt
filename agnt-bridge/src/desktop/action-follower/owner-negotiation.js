const { readString } = require("../desktop-ipc-shared");

// Historical origin is a hint, not a writer lease. Confirm a current Desktop
// writer with a read-only request or acquire the local runtime before mutations.
function createOwnerNegotiation({ ipc, readThreadMetadata, resumeThreadLocally,
  hasDesktopState, isLocallyOwnedThread, releaseDesktopThreadState,
  sendApplicationResponse, dispatch, timeoutMs = 1500 }) {
  const pending = new Map();
  const owners = new Map();
  const unavailable = new Set();
  let generation = 0;

  async function verify(threadId) {
    const current = generation;
    try {
      let clientId = owners.get(threadId);
      if (!clientId) {
        const envelope = await ipc.sendRequest("thread-owner-discovery", {
          hostId: "local", conversationId: threadId,
        }, { returnEnvelope: true, timeoutMs });
        clientId = readString(envelope?.handledByClientId);
      }
      if (!clientId || clientId === ipc.clientId) return false;
      const result = await ipc.sendRequest("thread-follower-load-complete-history", {
        conversationId: threadId,
      }, { targetClientId: clientId, timeoutMs });
      if (result?.revision == null || current !== generation) return false;
      owners.set(threadId, clientId);
      return true;
    } catch {
      if (current === generation) owners.delete(threadId);
      return false;
    }
  }

  async function negotiate(message, threadId, current) {
    const metadata = await readThreadMetadata(threadId);
    if (current !== generation) throw new Error("Connection changed while confirming the task owner.");
    const thread = metadata?.thread || metadata;
    if (thread?.id !== threadId) throw new Error("Task metadata did not match the requested task.");
    if (hasDesktopState(threadId) || await verify(threadId)) return { desktop: true, thread };
    if (current !== generation) throw new Error("Connection changed while confirming the task owner.");
    try {
      const result = await resumeThreadLocally(message, () => current === generation);
      if (current !== generation) throw new Error("Connection changed during local resume.");
      if (result?.thread?.id !== threadId) throw new Error("Local resume did not return the requested task.");
      owners.delete(threadId);
      releaseDesktopThreadState(threadId);
      return { result };
    } catch (error) {
      if (Number(error?.code) !== -32600 || !/active writer|already has a writer/i.test(error?.message || "")) throw error;
      if (hasDesktopState(threadId) || await verify(threadId)) return { desktop: true, thread };
      throw new Error("This task has an active writer, but its owner is unavailable. Open it in Codex Desktop and retry.");
    }
  }

  function reject(message, error) {
    if (message?.id != null) sendApplicationResponse(JSON.stringify({ id: message.id,
      error: { code: -32000, message: error.message || String(error) } }));
  }

  function handle(message, rawMessage, mutation) {
    if (typeof readThreadMetadata !== "function" || typeof resumeThreadLocally !== "function") return false;
    const threadId = readString(message?.params?.threadId) || readString(message?.params?.thread_id);
    if (!threadId || message.id == null || isLocallyOwnedThread(threadId)) return false;
    const current = generation;
    if (mutation && (pending.has(threadId) || unavailable.has(threadId))) {
      const request = pending.get(threadId);
      if (!request) reject(message, new Error("Reopen this task to confirm its owner before sending changes."));
      else request.then(() => {
        if (generation === current) dispatch(rawMessage, message);
      }).catch((error) => { if (generation === current) reject(message, error); });
      return true;
    }
    if (message.method !== "thread/resume") return false;
    unavailable.delete(threadId);
    let request = pending.get(threadId);
    if (!request) {
      request = negotiate(message, threadId, current).catch((error) => {
        if (generation === current) unavailable.add(threadId);
        throw error;
      });
      pending.set(threadId, request);
      request.finally(() => { if (pending.get(threadId) === request) pending.delete(threadId); }).catch(() => {});
    }
    request.then((outcome) => {
      if (generation !== current) return;
      if (outcome.desktop && message.params?.excludeTurns !== true) {
        throw new Error("This Desktop-owned task requires a metadata-only resume.");
      }
      sendApplicationResponse(JSON.stringify({ id: message.id, result: outcome.desktop
        ? { thread: { ...outcome.thread, turns: [] }, agntDesktopIpcMirror: true } : outcome.result }));
    }).catch((error) => { if (generation === current) reject(message, error); });
    return true;
  }

  return { handle, targetClientId: (id) => owners.get(id), hasOwner: (id) => owners.has(id),
    reset() { generation += 1; pending.clear(); owners.clear(); unavailable.clear(); } };
}

module.exports = { createOwnerNegotiation };
