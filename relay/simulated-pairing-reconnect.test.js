// FILE: simulated-pairing-reconnect.test.js
// Purpose: Exercises relay pairing, trusted reconnect, and secure replay without a live app or Simulator.
// Layer: Integration test
// Exports: node:test suite
// Depends on: node:test, node:assert/strict, crypto, ws, ./server, ../agnt-bridge/src/transport/secure-transport

const test = require("node:test");
const assert = require("node:assert/strict");
const WebSocket = require("ws");
const {
  SimulatedPhone,
  bindBridgeTransportToSocket,
  countRelayClients,
  createOkpKeyPair,
  createPhoneIdentity,
  delay,
  failUnexpectedDirectSend,
  onceClosed,
  onceOpen,
  resolveTrustedSessionEventually,
  waitUntil,
  withServer,
} = require("./simulated-pairing-test-helpers");
const {
  HANDSHAKE_MODE_QR_BOOTSTRAP,
  HANDSHAKE_MODE_TRUSTED_RECONNECT,
  createBridgeSecureTransport,
} = require("../agnt-bridge/src/transport/secure-transport");

test("simulated relay harness covers QR bootstrap, trusted resolve, and reconnect replay", async () => {
  await withServer(async ({ port, wss }) => {
    const sessionId = "simulated-pairing-session";
    const macDeviceId = "simulated-mac";
    const pairingCode = "AB23CD34";
    const macIdentity = createOkpKeyPair("ed25519");
    const phoneIdentity = createPhoneIdentity("simulated-phone");
    const applicationMessages = [];
    let macSocket = null;

    const secureTransport = createBridgeSecureTransport({
      sessionId,
      relayUrl: `ws://127.0.0.1:${port}/relay`,
      displayName: "Simulated Mac",
      deviceState: {
        macDeviceId,
        macIdentityPrivateKey: macIdentity.privateKey,
        macIdentityPublicKey: macIdentity.publicKey,
        trustedPhones: {},
      },
      onTrustedPhoneUpdate(nextDeviceState) {
        const trustedPhonePublicKey = nextDeviceState.trustedPhones[phoneIdentity.phoneDeviceId];
        macSocket.send(JSON.stringify({
          kind: "relayMacRegistration",
          registration: {
            macDeviceId,
            macIdentityPublicKey: macIdentity.publicKey,
            displayName: "Simulated Mac",
            trustedPhoneDeviceId: phoneIdentity.phoneDeviceId,
            trustedPhonePublicKey,
          },
        }));
      },
    });

    macSocket = new WebSocket(`ws://127.0.0.1:${port}/relay/${sessionId}`, {
      headers: {
        "x-role": "mac",
        "x-mac-device-id": macDeviceId,
        "x-mac-identity-public-key": macIdentity.publicKey,
        "x-machine-name": "Simulated Mac",
        "x-pairing-code": pairingCode,
        "x-pairing-version": "2",
        "x-pairing-expires-at": String(Date.now() + 60_000),
      },
    });
    await onceOpen(macSocket);
    bindBridgeTransportToSocket({ applicationMessages, secureTransport, socket: macSocket });

    const pairingResponse = await fetch(`http://127.0.0.1:${port}/v1/pairing/code/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "AB23-CD34" }),
    });
    const pairingPayload = await pairingResponse.json();
    assert.equal(pairingResponse.status, 200);
    assert.equal(pairingPayload.sessionId, sessionId);
    assert.equal(pairingPayload.macDeviceId, macDeviceId);
    assert.equal(pairingPayload.macIdentityPublicKey, macIdentity.publicKey);

    const firstPhoneSocket = new WebSocket(`ws://127.0.0.1:${port}/relay/${sessionId}`, {
      headers: { "x-role": "iphone" },
    });
    await onceOpen(firstPhoneSocket);
    const firstPhone = new SimulatedPhone({
      macDeviceId,
      macIdentityPublicKey: macIdentity.publicKey,
      phoneIdentity,
      sessionId,
      socket: firstPhoneSocket,
    });
    await firstPhone.completeHandshake({
      handshakeMode: HANDSHAKE_MODE_QR_BOOTSTRAP,
      lastAppliedBridgeOutboundSeq: 0,
    });
    await waitUntil(() => secureTransport.isSecureChannelReady());

    const trustedSession = await resolveTrustedSessionEventually(port, {
      macDeviceId,
      phoneIdentity,
    });
    assert.equal(trustedSession.status, 200);
    assert.equal(trustedSession.body.sessionId, sessionId);
    assert.equal(trustedSession.body.displayName, "Simulated Mac");

    firstPhone.sendApplicationMessage(JSON.stringify({
      id: "request-1",
      method: "thread/list",
      params: {},
    }));
    await waitUntil(() => applicationMessages.length === 1);
    assert.deepEqual(applicationMessages, [
      JSON.stringify({ id: "request-1", method: "thread/list", params: {} }),
    ]);

    secureTransport.queueOutboundApplicationMessage(
      JSON.stringify({ id: "response-1", result: { ok: true } }),
      failUnexpectedDirectSend
    );
    const firstOutbound = await firstPhone.nextBridgePayload();
    assert.equal(firstOutbound.bridgeOutboundSeq, 1);
    assert.equal(firstOutbound.payloadText, JSON.stringify({ id: "response-1", result: { ok: true } }));

    const firstPhoneClosed = onceClosed(firstPhoneSocket);
    firstPhoneSocket.close();
    await firstPhoneClosed;
    await waitUntil(() => countRelayClients(wss, "iphone") === 0);

    secureTransport.queueOutboundApplicationMessage(
      JSON.stringify({ id: "response-2", result: { replayed: true } }),
      failUnexpectedDirectSend
    );
    await delay(25);

    const secondPhoneSocket = new WebSocket(`ws://127.0.0.1:${port}/relay/${sessionId}`, {
      headers: { "x-role": "iphone" },
    });
    await onceOpen(secondPhoneSocket);
    const secondPhone = new SimulatedPhone({
      macDeviceId,
      macIdentityPublicKey: macIdentity.publicKey,
      phoneIdentity,
      sessionId,
      socket: secondPhoneSocket,
    });
    await secondPhone.completeHandshake({
      handshakeMode: HANDSHAKE_MODE_TRUSTED_RECONNECT,
      lastAppliedBridgeOutboundSeq: firstOutbound.bridgeOutboundSeq,
    });

    const replayedPayload = await secondPhone.nextBridgePayload();
    assert.equal(replayedPayload.bridgeOutboundSeq, 2);
    assert.equal(replayedPayload.payloadText, JSON.stringify({ id: "response-2", result: { replayed: true } }));

    secondPhoneSocket.close();
    macSocket.close();
    await Promise.all([onceClosed(secondPhoneSocket), onceClosed(macSocket)]);
  });
});
