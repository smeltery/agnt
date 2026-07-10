const test = require("node:test");
const assert = require("node:assert/strict");

test("package entrypoint exposes bridge lifecycle helpers", () => {
  const agnt = require("../../src");

  for (const name of ["startBridge", "openLastActiveThread", "watchThreadRollout"]) {
    assert.equal(typeof agnt[name], "function", `missing export: ${name}`);
  }
});
