// FILE: contracts/mac-registration.test.js
// Purpose: Pins the Mac identity + trusted-phone registration builder that
//          the bridge announces to the relay on every (re)connect. Two
//          load-bearing rules:
//          1. Required identity fields are surfaced verbatim from deviceState
//             (macDeviceId, macIdentityPublicKey).
//          2. The trusted-phone pair is only emitted when both id and
//             public-key are present — otherwise iOS auto-resolve picks
//             the wrong phone or rejects an incomplete pair.
//          3. The header builder serialises numeric pairing version /
//             expiry as strings (HTTP-header constraint) and only sets
//             trusted-phone headers when both halves are present.
// Layer: Contract test
// Exports: node:test suite

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");

const {
  buildMacRegistration,
  buildMacRegistrationHeaders,
} = require("../../src/bridge/mac-registration");

// ─── buildMacRegistration ───────────────────────────────────────────────────

test("buildMacRegistration surfaces deviceState identity fields verbatim", () => {
  const out = buildMacRegistration(
    {
      macDeviceId: "mac-abc",
      macIdentityPublicKey: "pubkey-xyz",
      trustedPhones: {},
    },
    null,
  );
  assert.equal(out.macDeviceId, "mac-abc");
  assert.equal(out.macIdentityPublicKey, "pubkey-xyz");
});

test("buildMacRegistration uses os.hostname() for displayName", () => {
  const out = buildMacRegistration({ macDeviceId: "mac-1" }, null);
  assert.equal(out.displayName, os.hostname());
});

test("buildMacRegistration picks the first trusted-phone entry", () => {
  const out = buildMacRegistration(
    {
      macDeviceId: "mac-1",
      trustedPhones: {
        "phone-id-1": "phone-key-1",
        "phone-id-2": "phone-key-2",
      },
    },
    null,
  );
  assert.equal(out.trustedPhoneDeviceId, "phone-id-1");
  assert.equal(out.trustedPhonePublicKey, "phone-key-1");
});

test("buildMacRegistration returns empty strings for missing trusted-phone entry", () => {
  const out = buildMacRegistration({ macDeviceId: "mac-1", trustedPhones: {} }, null);
  assert.equal(out.trustedPhoneDeviceId, "");
  assert.equal(out.trustedPhonePublicKey, "");
});

test("buildMacRegistration accepts missing/undefined trustedPhones", () => {
  const out = buildMacRegistration({ macDeviceId: "mac-1" }, null);
  assert.equal(out.trustedPhoneDeviceId, "");
});

test("buildMacRegistration surfaces pairing fields from session when present", () => {
  const out = buildMacRegistration(
    { macDeviceId: "mac-1" },
    {
      pairingCode: "ABC123",
      pairingPayload: { v: 2, expiresAt: 1700000000000 },
    },
  );
  assert.equal(out.pairingCode, "ABC123");
  assert.equal(out.pairingVersion, 2);
  assert.equal(out.pairingExpiresAt, 1700000000000);
});

test("buildMacRegistration zeroes out non-finite pairing version + expiry", () => {
  const out = buildMacRegistration(
    { macDeviceId: "mac-1" },
    { pairingCode: "ABC", pairingPayload: { v: "two", expiresAt: NaN } },
  );
  assert.equal(out.pairingVersion, 0);
  assert.equal(out.pairingExpiresAt, 0);
});

test("buildMacRegistration tolerates null pairingSession", () => {
  const out = buildMacRegistration({ macDeviceId: "mac-1" }, null);
  assert.equal(out.pairingCode, "");
  assert.equal(out.pairingVersion, 0);
  assert.equal(out.pairingExpiresAt, 0);
});

// ─── buildMacRegistrationHeaders ────────────────────────────────────────────

test("buildMacRegistrationHeaders emits all required x-* headers", () => {
  const headers = buildMacRegistrationHeaders(
    {
      macDeviceId: "mac-1",
      macIdentityPublicKey: "pub-1",
      trustedPhones: {},
    },
    { pairingCode: "ABC", pairingPayload: { v: 1, expiresAt: 1234 } },
  );
  assert.equal(headers["x-mac-device-id"], "mac-1");
  assert.equal(headers["x-mac-identity-public-key"], "pub-1");
  assert.equal(headers["x-machine-name"], os.hostname());
  assert.equal(headers["x-pairing-code"], "ABC");
  assert.equal(headers["x-pairing-version"], "1");
  assert.equal(headers["x-pairing-expires-at"], "1234");
});

test("buildMacRegistrationHeaders sets pairing version/expires as empty strings when missing", () => {
  // HTTP headers can't carry numbers; missing values must serialise as "" not undefined.
  const headers = buildMacRegistrationHeaders(
    { macDeviceId: "mac-1", trustedPhones: {} },
    null,
  );
  assert.equal(headers["x-pairing-version"], "");
  assert.equal(headers["x-pairing-expires-at"], "");
});

test("buildMacRegistrationHeaders omits trusted-phone headers when either half is missing", () => {
  const onlyId = buildMacRegistrationHeaders(
    { macDeviceId: "m", trustedPhones: { "phone-id": "" } },
    null,
  );
  assert.equal(onlyId["x-trusted-phone-device-id"], undefined);
  assert.equal(onlyId["x-trusted-phone-public-key"], undefined);
});

test("buildMacRegistrationHeaders includes trusted-phone headers when both halves are present", () => {
  const headers = buildMacRegistrationHeaders(
    {
      macDeviceId: "m",
      trustedPhones: { "phone-id": "phone-key" },
    },
    null,
  );
  assert.equal(headers["x-trusted-phone-device-id"], "phone-id");
  assert.equal(headers["x-trusted-phone-public-key"], "phone-key");
});
