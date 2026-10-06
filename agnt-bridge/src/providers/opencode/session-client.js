const { readString } = require("../_shared/translator-utils");

// Remember project context per session; visiting another chat must not move a running turn.
function createOpencodeSessionClient(transport) {
  const sessions = new Map();
  const settings = new Map();
  function remember(session) {
    if (session?.id) sessions.set(session.id, { ...sessions.get(session.id), ...session });
  }
  return {
    remember,
    settings,
    getSession: (id) => sessions.get(id),
    async httpRequest(method, route, body, cwd) {
      const match = /^\/session\/([^/?]+)/.exec(route);
      const id = match && decodeURIComponent(match[1]);
      const directory = readString(cwd) || readString(sessions.get(id)?.directory);
      const path = directory ? `${route}${route.includes("?") ? "&" : "?"}directory=${encodeURIComponent(directory)}` : route;
      const response = await transport.httpRequest(method, path, body);
      if (!response || response.status < 200 || response.status >= 300) {
        const error = new Error(readString(response?.json?.error?.message)
          || readString(response?.json?.message) || `opencode ${method} ${route} failed (HTTP ${response?.status || 0})`);
        error.status = response?.status;
        throw error;
      }
      if (response.json?.id && response.json?.directory) remember(response.json);
      return response;
    },
  };
}

module.exports = { createOpencodeSessionClient };
