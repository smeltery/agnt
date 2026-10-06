const { createThreadActivityProjector, APP_SERVER_SOURCE, DESKTOP_IPC_SOURCE } = require("./projector");
const { createThreadActivityStore } = require("./store");

function createThreadActivityCoordinator({ sendApplicationResponse, isLocallyOwnedThread = () => false }) {
  const projector = createThreadActivityProjector();
  const store = createThreadActivityStore({
    sendApplicationResponse,
    onEvict: (threadId, source) => projector.forget(threadId, source),
  });
  function parse(message) {
    if (typeof message !== "string") return message;
    try { return JSON.parse(message); } catch { return null; }
  }
  return {
    handleRequest: (message) => store.handleRequest(parse(message)),
    observe(message) {
      message = parse(message);
      const projection = projector.observeAppServer(message);
      if (projection?.removedThreadId) { store.remove(projection.removedThreadId); return; }
      if (!projection?.entry) return;
      const entry = projection.entry;
      const previous = store.get(entry.threadId);
      if (previous?.source === DESKTOP_IPC_SOURCE && !isLocallyOwnedThread(entry.threadId)) {
        // Metadata does not transfer ownership away from a Desktop writer.
        if (["thread/started", "thread/name/updated"].includes(message.method)) {
          store.upsert({ ...previous, ...(entry.title ? { title: entry.title } : {}), ...(entry.cwd ? { cwd: entry.cwd } : {}) });
        }
        return;
      }
      store.upsert({ ...(previous?.title ? { title: previous.title } : {}), ...(previous?.cwd ? { cwd: previous.cwd } : {}), ...entry });
    },
    observeDesktop(observation) {
      if (observation.type === "state") {
        store.upsert(projector.projectDesktopState(observation.threadId, observation.state, observation.sourceGeneration));
      } else if (observation.type === "disconnected") {
        store.markSourceStale(DESKTOP_IPC_SOURCE, observation.sourceGeneration);
      } else if (observation.type === "removed") {
        store.remove(observation.threadId, { source: DESKTOP_IPC_SOURCE });
      }
    },
    resetSubscriber: store.resetSubscriber,
    markRuntimeStale: () => store.markSourceStale(APP_SERVER_SOURCE),
    dispose: store.dispose,
  };
}

module.exports = { createThreadActivityCoordinator };
