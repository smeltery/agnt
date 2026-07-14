// FILE: server-websocket.test.js
// Purpose: Verifies websocket relay role handling and mac absence behavior.
// Layer: Unit test
// Exports: node:test suite
// Depends on: node:test, node:assert/strict, ws, ./server-test-helpers

const test = require("node:test");
const assert = require("node:assert/strict");
const WebSocket = require("ws");
const {
  withServer,
  onceOpen,
  onceMessage,
  onceClosed,
  onceCloseDetails,
  delay,
} = require("./server-test-helpers");

test("websocket relay forwards between mac and iphone on the base relay path", async () => {
  await withServer(async ({ port }) => {
    const mac = new WebSocket(`ws://127.0.0.1:${port}/relay/session-1`, {
      headers: { "x-role": "mac" },
    });
    const iphone = new WebSocket(`ws://127.0.0.1:${port}/relay/session-1`, {
      headers: { "x-role": "iphone" },
    });

    await Promise.all([onceOpen(mac), onceOpen(iphone)]);

    const received = new Promise((resolve) => {
      iphone.once("message", (value) => resolve(value.toString("utf8")));
    });
    mac.send(JSON.stringify({ ok: true }));
    assert.equal(await received, "{\"ok\":true}");

    const macClosed = onceClosed(mac);
    const iphoneClosed = onceClosed(iphone);
    mac.close();
    iphone.close();
    await Promise.all([macClosed, iphoneClosed]);
  });
});

test("websocket relay accepts android as a mobile role from query string", async () => {
  await withServer(async ({ port }) => {
    const mac = new WebSocket(`ws://127.0.0.1:${port}/relay/session-android`, {
      headers: { "x-role": "mac" },
    });
    await onceOpen(mac);

    const android = new WebSocket(`ws://127.0.0.1:${port}/relay/session-android?role=android`);
    await onceOpen(android);

    const messageFromAndroid = onceMessage(mac);
    android.send("from-android");
    assert.equal(await messageFromAndroid, "from-android");

    const messageFromMac = onceMessage(android);
    mac.send("from-mac");
    assert.equal(await messageFromMac, "from-mac");

    const macClosed = onceClosed(mac);
    const androidClosed = onceClosed(android);
    android.close();
    mac.close();
    await Promise.all([androidClosed, macClosed]);
  });
});

test("websocket relay accepts iphone as a mobile role from query string", async () => {
  await withServer(async ({ port }) => {
    const mac = new WebSocket(`ws://127.0.0.1:${port}/relay/session-iphone-query`, {
      headers: { "x-role": "mac" },
    });
    const iphone = new WebSocket(`ws://127.0.0.1:${port}/relay/session-iphone-query?role=iphone`);

    await Promise.all([onceOpen(mac), onceOpen(iphone)]);

    const received = onceMessage(iphone);
    mac.send(JSON.stringify({ ok: true }));
    assert.equal(await received, "{\"ok\":true}");

    const macClosed = onceClosed(mac);
    const iphoneClosed = onceClosed(iphone);
    mac.close();
    iphone.close();
    await Promise.all([macClosed, iphoneClosed]);
  });
});

test("websocket relay prefers x-role over query role", async () => {
  await withServer(async ({ port }) => {
    const mac = new WebSocket(`ws://127.0.0.1:${port}/relay/session-role-precedence`, {
      headers: { "x-role": "mac" },
    });
    const invalidClient = new WebSocket(
      `ws://127.0.0.1:${port}/relay/session-role-precedence?role=android`,
      { headers: { "x-role": "tablet" } }
    );

    await onceOpen(mac);
    const { code, reason } = await onceCloseDetails(invalidClient);

    assert.equal(code, 4000);
    assert.equal(reason, "Missing sessionId or invalid role");

    const macClosed = onceClosed(mac);
    mac.close();
    await macClosed;
  });
});

test("websocket relay rejects invalid query roles", async () => {
  await withServer(async ({ port }) => {
    const mac = new WebSocket(`ws://127.0.0.1:${port}/relay/session-invalid-query-role`, {
      headers: { "x-role": "mac" },
    });
    const invalidClient = new WebSocket(
      `ws://127.0.0.1:${port}/relay/session-invalid-query-role?role=tablet`
    );

    await onceOpen(mac);
    const { code, reason } = await onceCloseDetails(invalidClient);

    assert.equal(code, 4000);
    assert.equal(reason, "Missing sessionId or invalid role");

    const macClosed = onceClosed(mac);
    mac.close();
    await macClosed;
  });
});

test("relay keeps the iPhone connected briefly but rejects new sends while the mac is absent", async () => {
  await withServer(async ({ port }) => {
    const mac = new WebSocket(`ws://127.0.0.1:${port}/relay/session-grace`, {
      headers: { "x-role": "mac" },
    });
    const iphone = new WebSocket(`ws://127.0.0.1:${port}/relay/session-grace`, {
      headers: { "x-role": "iphone" },
    });

    await Promise.all([onceOpen(mac), onceOpen(iphone)]);

    let iphoneClosed = false;
    iphone.once("close", () => {
      iphoneClosed = true;
    });

    const macClosed = onceClosed(mac);
    mac.close();
    await macClosed;

    await delay(40);
    assert.equal(iphoneClosed, false);

    const closeDetails = onceCloseDetails(iphone);
    iphone.send(JSON.stringify({ buffered: true }));

    const { code, reason } = await closeDetails;
    assert.equal(code, 4004);
    assert.equal(reason, "Mac temporarily unavailable");
  }, {
    relayOptions: {
      macAbsenceGraceMs: 250,
    },
  });
});

test("relay lets the iPhone reconnect during the mac absence grace window", async () => {
  await withServer(async ({ port }) => {
    const mac = new WebSocket(`ws://127.0.0.1:${port}/relay/session-grace-rejoin`, {
      headers: { "x-role": "mac" },
    });
    const iphone = new WebSocket(`ws://127.0.0.1:${port}/relay/session-grace-rejoin`, {
      headers: { "x-role": "iphone" },
    });

    await Promise.all([onceOpen(mac), onceOpen(iphone)]);

    const macClosed = onceClosed(mac);
    mac.close();
    await macClosed;

    const iphoneClosed = onceClosed(iphone);
    iphone.close();
    await iphoneClosed;

    const rejoinedIphone = new WebSocket(`ws://127.0.0.1:${port}/relay/session-grace-rejoin`, {
      headers: { "x-role": "iphone" },
    });
    await onceOpen(rejoinedIphone);

    const reconnectedMac = new WebSocket(`ws://127.0.0.1:${port}/relay/session-grace-rejoin`, {
      headers: { "x-role": "mac" },
    });
    await onceOpen(reconnectedMac);

    const received = onceMessage(reconnectedMac);
    rejoinedIphone.send(JSON.stringify({ liveAfterRejoin: true }));

    assert.equal(await received, "{\"liveAfterRejoin\":true}");

    const rejoinedIphoneClosed = onceClosed(rejoinedIphone);
    const reconnectedMacClosed = onceClosed(reconnectedMac);
    rejoinedIphone.close();
    reconnectedMac.close();
    await Promise.all([rejoinedIphoneClosed, reconnectedMacClosed]);
  }, {
    relayOptions: {
      macAbsenceGraceMs: 250,
    },
  });
});

test("relay closes with a dedicated code when the iphone sends during mac absence", async () => {
  await withServer(async ({ port }) => {
    const mac = new WebSocket(`ws://127.0.0.1:${port}/relay/session-buffer-full`, {
      headers: { "x-role": "mac" },
    });
    const iphone = new WebSocket(`ws://127.0.0.1:${port}/relay/session-buffer-full`, {
      headers: { "x-role": "iphone" },
    });

    await Promise.all([onceOpen(mac), onceOpen(iphone)]);

    const macClosed = onceClosed(mac);
    mac.close();
    await macClosed;

    const closeDetails = onceCloseDetails(iphone);
    iphone.send(JSON.stringify({ buffered: 1 }));

    const { code, reason } = await closeDetails;
    assert.equal(code, 4004);
    assert.equal(reason, "Mac temporarily unavailable");
  }, {
    relayOptions: {
      macAbsenceGraceMs: 250,
    },
  });
});
