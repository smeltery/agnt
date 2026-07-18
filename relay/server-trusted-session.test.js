// FILE: server-trusted-session.test.js
// Purpose: Verifies trusted-session and pairing-code relay HTTP resolution.
// Layer: Unit test
// Exports: node:test suite
// Depends on: node:test, node:assert/strict, ws, ./server-test-helpers

const test = require("node:test");
const assert = require("node:assert/strict");
const WebSocket = require("ws");
const {
  withServer,
  onceOpen,
  onceClosed,
  delay,
  makePhoneIdentity,
  makeTrustedResolveBody,
} = require("./server-test-helpers");

test("trusted session resolve returns the current live session for a trusted iphone", async () => {
  const phoneIdentity = makePhoneIdentity();

  await withServer(async ({ port }) => {
    const mac = new WebSocket(`ws://127.0.0.1:${port}/relay/live-session-1`, {
      headers: {
        "x-role": "mac",
        "x-mac-device-id": "mac-1",
        "x-mac-identity-public-key": "mac-public-key-1",
        "x-machine-name": "Test-Mac",
        "x-trusted-phone-device-id": phoneIdentity.phoneDeviceId,
        "x-trusted-phone-public-key": phoneIdentity.phoneIdentityPublicKey,
      },
    });
    await onceOpen(mac);

    const body = makeTrustedResolveBody({
      macDeviceId: "mac-1",
      phoneIdentity,
      nonce: "nonce-1",
      timestamp: Date.now(),
    });
    const response = await fetch(`http://127.0.0.1:${port}/v1/trusted/session/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      macDeviceId: "mac-1",
      macIdentityPublicKey: "mac-public-key-1",
      displayName: "Test-Mac",
      sessionId: "live-session-1",
    });

    const macClosed = onceClosed(mac);
    mac.close();
    await macClosed;
  });
});

test("trusted session resolve also works when the relay HTTP API is mounted under /relay", async () => {
  const phoneIdentity = makePhoneIdentity();

  await withServer(async ({ port }) => {
    const mac = new WebSocket(`ws://127.0.0.1:${port}/relay/live-session-prefixed`, {
      headers: {
        "x-role": "mac",
        "x-mac-device-id": "mac-prefixed",
        "x-mac-identity-public-key": "mac-public-key-prefixed",
        "x-trusted-phone-device-id": phoneIdentity.phoneDeviceId,
        "x-trusted-phone-public-key": phoneIdentity.phoneIdentityPublicKey,
      },
    });
    await onceOpen(mac);

    const body = makeTrustedResolveBody({
      macDeviceId: "mac-prefixed",
      phoneIdentity,
      nonce: "nonce-prefixed",
      timestamp: Date.now(),
    });
    const response = await fetch(`http://127.0.0.1:${port}/relay/v1/trusted/session/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    assert.equal(response.status, 200);
    assert.equal((await response.json()).sessionId, "live-session-prefixed");

    const macClosed = onceClosed(mac);
    mac.close();
    await macClosed;
  });
});

test("trusted session resolve routes each trusted mobile device to its own live mac channel", async () => {
  const phone = makePhoneIdentity();
  const android = makePhoneIdentity();

  await withServer(async ({ port }) => {
    const firstMacChannel = new WebSocket(`ws://127.0.0.1:${port}/relay/live-session-phone`, {
      headers: {
        "x-role": "mac",
        "x-mac-device-id": "mac-multi",
        "x-mac-identity-public-key": "mac-public-key-multi",
        "x-machine-name": "Test-Mac",
        "x-trusted-phone-device-id": phone.phoneDeviceId,
        "x-trusted-phone-public-key": phone.phoneIdentityPublicKey,
      },
    });
    const secondMacChannel = new WebSocket(`ws://127.0.0.1:${port}/relay/live-session-android`, {
      headers: {
        "x-role": "mac",
        "x-mac-device-id": "mac-multi",
        "x-mac-identity-public-key": "mac-public-key-multi",
        "x-machine-name": "Test-Mac",
        "x-trusted-phone-device-id": android.phoneDeviceId,
        "x-trusted-phone-public-key": android.phoneIdentityPublicKey,
      },
    });
    await Promise.all([onceOpen(firstMacChannel), onceOpen(secondMacChannel)]);

    const phoneResponse = await fetch(`http://127.0.0.1:${port}/v1/trusted/session/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(makeTrustedResolveBody({
        macDeviceId: "mac-multi",
        phoneIdentity: phone,
        nonce: "nonce-phone-channel",
        timestamp: Date.now(),
      })),
    });
    const androidResponse = await fetch(`http://127.0.0.1:${port}/v1/trusted/session/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(makeTrustedResolveBody({
        macDeviceId: "mac-multi",
        phoneIdentity: android,
        nonce: "nonce-android-channel",
        timestamp: Date.now(),
      })),
    });

    assert.equal(phoneResponse.status, 200);
    assert.equal(androidResponse.status, 200);
    assert.equal((await phoneResponse.json()).sessionId, "live-session-phone");
    assert.equal((await androidResponse.json()).sessionId, "live-session-android");

    const firstClosed = onceClosed(firstMacChannel);
    const secondClosed = onceClosed(secondMacChannel);
    firstMacChannel.close();
    secondMacChannel.close();
    await Promise.all([firstClosed, secondClosed]);
  });
});

test("pairing code resolve returns bootstrap metadata for a live mac session", async () => {
  await withServer(async ({ port }) => {
    const expiresAt = Date.now() + 60_000;
    const mac = new WebSocket(`ws://127.0.0.1:${port}/relay/pairing-live-1`, {
      headers: {
        "x-role": "mac",
        "x-mac-device-id": "mac-pairing-1",
        "x-mac-identity-public-key": "mac-public-key-pairing-1",
        "x-pairing-code": "AB23CD34EF",
        "x-pairing-version": "2",
        "x-pairing-expires-at": String(expiresAt),
      },
    });
    await onceOpen(mac);

    const response = await fetch(`http://127.0.0.1:${port}/v1/pairing/code/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "AB23-CD34EF" }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      v: 2,
      sessionId: "pairing-live-1",
      macDeviceId: "mac-pairing-1",
      macIdentityPublicKey: "mac-public-key-pairing-1",
      expiresAt,
    });

    const macClosed = onceClosed(mac);
    mac.close();
    await macClosed;
  });
});

test("pairing code resolve also works when the relay HTTP API is mounted under /relay", async () => {
  await withServer(async ({ port }) => {
    const expiresAt = Date.now() + 60_000;
    const mac = new WebSocket(`ws://127.0.0.1:${port}/relay/pairing-live-prefixed`, {
      headers: {
        "x-role": "mac",
        "x-mac-device-id": "mac-pairing-prefixed",
        "x-mac-identity-public-key": "mac-public-key-pairing-prefixed",
        "x-pairing-code": "PR23CD34EF",
        "x-pairing-version": "2",
        "x-pairing-expires-at": String(expiresAt),
      },
    });
    await onceOpen(mac);

    const response = await fetch(`http://127.0.0.1:${port}/relay/v1/pairing/code/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "PR23CD34EF" }),
    });

    assert.equal(response.status, 200);
    assert.equal((await response.json()).sessionId, "pairing-live-prefixed");

    const macClosed = onceClosed(mac);
    mac.close();
    await macClosed;
  });
});

test("pairing code resolve rejects expired codes", async () => {
  await withServer(async ({ port }) => {
    const mac = new WebSocket(`ws://127.0.0.1:${port}/relay/pairing-live-2`, {
      headers: {
        "x-role": "mac",
        "x-mac-device-id": "mac-pairing-2",
        "x-mac-identity-public-key": "mac-public-key-pairing-2",
        "x-pairing-code": "ZX34CV56BN",
        "x-pairing-version": "2",
        "x-pairing-expires-at": String(Date.now() - 1_000),
      },
    });
    await onceOpen(mac);

    const response = await fetch(`http://127.0.0.1:${port}/v1/pairing/code/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "ZX34CV56BN" }),
    });
    const body = await response.json();

    assert.equal(response.status, 410);
    assert.equal(body.code, "pairing_code_expired");

    const macClosed = onceClosed(mac);
    mac.close();
    await macClosed;
  });
});

test("trusted session resolve rejects iphones that are not trusted for the live mac", async () => {
  const trustedPhone = makePhoneIdentity();
  const otherPhone = makePhoneIdentity();

  await withServer(async ({ port }) => {
    const mac = new WebSocket(`ws://127.0.0.1:${port}/relay/live-session-2`, {
      headers: {
        "x-role": "mac",
        "x-mac-device-id": "mac-2",
        "x-mac-identity-public-key": "mac-public-key-2",
        "x-trusted-phone-device-id": trustedPhone.phoneDeviceId,
        "x-trusted-phone-public-key": trustedPhone.phoneIdentityPublicKey,
      },
    });
    await onceOpen(mac);

    const response = await fetch(`http://127.0.0.1:${port}/v1/trusted/session/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(makeTrustedResolveBody({
        macDeviceId: "mac-2",
        phoneIdentity: otherPhone,
        nonce: "nonce-2",
        timestamp: Date.now(),
      })),
    });
    const body = await response.json();

    assert.equal(response.status, 403);
    assert.equal(body.code, "phone_not_trusted");

    const macClosed = onceClosed(mac);
    mac.close();
    await macClosed;
  });
});

test("trusted session resolve rejects replayed nonces", async () => {
  const phoneIdentity = makePhoneIdentity();

  await withServer(async ({ port }) => {
    const mac = new WebSocket(`ws://127.0.0.1:${port}/relay/live-session-3`, {
      headers: {
        "x-role": "mac",
        "x-mac-device-id": "mac-3",
        "x-mac-identity-public-key": "mac-public-key-3",
        "x-trusted-phone-device-id": phoneIdentity.phoneDeviceId,
        "x-trusted-phone-public-key": phoneIdentity.phoneIdentityPublicKey,
      },
    });
    await onceOpen(mac);

    const body = makeTrustedResolveBody({
      macDeviceId: "mac-3",
      phoneIdentity,
      nonce: "reused-nonce",
      timestamp: Date.now(),
    });
    const firstResponse = await fetch(`http://127.0.0.1:${port}/v1/trusted/session/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(firstResponse.status, 200);

    const replayResponse = await fetch(`http://127.0.0.1:${port}/v1/trusted/session/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const replayBody = await replayResponse.json();

    assert.equal(replayResponse.status, 409);
    assert.equal(replayBody.code, "resolve_request_replayed");

    const macClosed = onceClosed(mac);
    mac.close();
    await macClosed;
  });
});

test("trusted session resolve reports an offline mac without pretending the endpoint is missing", async () => {
  const phoneIdentity = makePhoneIdentity();

  await withServer(async ({ port }) => {
    const response = await fetch(`http://127.0.0.1:${port}/v1/trusted/session/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(makeTrustedResolveBody({
        macDeviceId: "mac-offline",
        phoneIdentity,
        nonce: "nonce-offline",
        timestamp: Date.now(),
      })),
    });
    const body = await response.json();

    assert.equal(response.status, 404);
    assert.equal(body.code, "session_unavailable");
  });
});

test("trusted session resolve starts working immediately after a mac updates its trusted-phone registration", async () => {
  const phoneIdentity = makePhoneIdentity();

  await withServer(async ({ port }) => {
    const mac = new WebSocket(`ws://127.0.0.1:${port}/relay/live-session-4`, {
      headers: {
        "x-role": "mac",
        "x-mac-device-id": "mac-4",
        "x-mac-identity-public-key": "mac-public-key-4",
      },
    });
    await onceOpen(mac);

    mac.send(JSON.stringify({
      kind: "relayMacRegistration",
      registration: {
        macDeviceId: "mac-4",
        macIdentityPublicKey: "mac-public-key-4",
        displayName: "Updated-Mac",
        trustedPhoneDeviceId: phoneIdentity.phoneDeviceId,
        trustedPhonePublicKey: phoneIdentity.phoneIdentityPublicKey,
      },
    }));
    // mac.send is fire-and-forget — the server's WS `message` handler runs
    // in a separate I/O slot from the upcoming HTTP request, so without a
    // barrier the resolve fetch can race ahead of applyMacRegistrationMessage
    // and see the still-empty trusted-phone fields (403 phone_not_trusted).
    await delay(50);

    const response = await fetch(`http://127.0.0.1:${port}/v1/trusted/session/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(makeTrustedResolveBody({
        macDeviceId: "mac-4",
        phoneIdentity,
        nonce: "nonce-live-update",
        timestamp: Date.now(),
      })),
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.displayName, "Updated-Mac");
    assert.equal(body.sessionId, "live-session-4");

    const macClosed = onceClosed(mac);
    mac.close();
    await macClosed;
  });
});
