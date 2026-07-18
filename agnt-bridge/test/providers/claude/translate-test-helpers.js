const { createClaudeTranslator } = require("../../../src/providers/claude/translate");

function setupTranslator(envOverride = process.env) {
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
  const translator = createClaudeTranslator({
    injectInbound: (line) => injected.push(line),
    transport,
    env: envOverride,
  });
  return { translator, injected, transport, transportCalls };
}

function parseInjected(injected) {
  return injected.map((line) => JSON.parse(line));
}

module.exports = {
  createClaudeTranslator,
  parseInjected,
  setupTranslator,
};
