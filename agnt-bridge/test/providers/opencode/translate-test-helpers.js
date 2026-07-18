// FILE: translate-test-helpers.js
// Purpose: Shared opencode translator test setup.
// Layer: Test helper

const { createOpencodeTranslator } = require("../../../src/providers/opencode/translate");

function setupTranslator({ httpHandler } = {}) {
  const injected = [];
  const httpCalls = [];
  const transport = {
    describe: () => "fake-opencode",
    send() {},
    httpRequest(method, pathName, body) {
      httpCalls.push({ method, pathName, body });
      if (httpHandler) return Promise.resolve(httpHandler(method, pathName, body));
      return Promise.resolve({ status: 200, json: null, raw: "" });
    },
  };
  const translator = createOpencodeTranslator({
    injectInbound: (line) => injected.push(line),
    transport,
    env: process.env,
  });
  return { translator, injected, httpCalls };
}

function parseInjected(injected) {
  return injected.map((line) => JSON.parse(line));
}

module.exports = {
  createOpencodeTranslator,
  parseInjected,
  setupTranslator,
};
