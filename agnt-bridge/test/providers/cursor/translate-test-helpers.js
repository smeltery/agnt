const { createCursorTranslator } = require("../../../src/providers/cursor/translate");

function setupTranslator(envOverride = {}) {
  const injected = [];
  const transportCalls = [];
  const transport = {
    send() {},
    describe: () => "fake",
    setResumeSessionId(id) { transportCalls.push(["resume", id]); },
    setCwd(cwd) { transportCalls.push(["cwd", cwd]); },
    setTurnArgs(args) { transportCalls.push(["turnArgs", args.slice()]); },
    interruptTurn() { transportCalls.push(["interrupt"]); },
  };
  const translator = createCursorTranslator({
    injectInbound: (line) => injected.push(line),
    transport,
    env: { ...process.env, ...envOverride },
  });
  return { translator, injected, transport, transportCalls };
}

function parseInjected(injected) {
  return injected.map((line) => JSON.parse(line));
}

module.exports = {
  createCursorTranslator,
  parseInjected,
  setupTranslator,
};
