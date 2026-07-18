// FILE: voice-handler-test-helpers.js
// Purpose: Provides shared fixtures for voice handler tests.
// Layer: Unit test helper
// Exports: makeJWT, makeTestWavBase64, makeTestM4ABase64, tick, waitUntil

function makeJWT(payload) {
  const header = base64UrlEncode({ alg: "none", typ: "JWT" });
  const body = base64UrlEncode(payload);
  return `${header}.${body}.signature`;
}

function makeTestWavBase64({ sampleRateHz = 24_000, durationSeconds = null } = {}) {
  const dataByteCount = durationSeconds == null
    ? 2
    : Math.max(2, Math.floor(durationSeconds * sampleRateHz * 2));
  const wav = Buffer.alloc(44 + dataByteCount);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + dataByteCount, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRateHz, 24);
  wav.writeUInt32LE(sampleRateHz * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(dataByteCount, 40);
  return wav.toString("base64");
}

function makeTestM4ABase64({
  durationSeconds = 1,
  mediaDurationSeconds = durationSeconds,
  brand = "M4A ",
  compatibleBrand = "M4A ",
  channelCount = 1,
  sampleRateHz = 24_000,
} = {}) {
  const mvhdPayload = Buffer.alloc(100);
  mvhdPayload.writeUInt8(0, 0);
  mvhdPayload.writeUInt32BE(1_000, 12);
  mvhdPayload.writeUInt32BE(Math.max(1, Math.round(durationSeconds * 1_000)), 16);

  const mdhdPayload = Buffer.alloc(20);
  mdhdPayload.writeUInt8(0, 0);
  mdhdPayload.writeUInt32BE(sampleRateHz, 12);
  mdhdPayload.writeUInt32BE(Math.max(1, Math.round(mediaDurationSeconds * sampleRateHz)), 16);

  const hdlrPayload = Buffer.alloc(24);
  hdlrPayload.write("soun", 8, "ascii");

  const mp4aPayload = Buffer.alloc(28);
  mp4aPayload.writeUInt16BE(1, 6);
  mp4aPayload.writeUInt16BE(channelCount, 16);
  mp4aPayload.writeUInt16BE(16, 18);
  mp4aPayload.writeUInt32BE(sampleRateHz << 16, 24);

  const stsdPayload = Buffer.concat([
    Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]),
    mp4Box("mp4a", mp4aPayload),
  ]);
  const stbl = mp4Box("stbl", mp4Box("stsd", stsdPayload));
  const minf = mp4Box("minf", stbl);
  const mdia = mp4Box("mdia", Buffer.concat([
    mp4Box("mdhd", mdhdPayload),
    mp4Box("hdlr", hdlrPayload),
    minf,
  ]));
  const trak = mp4Box("trak", mdia);
  const moov = mp4Box("moov", Buffer.concat([
    mp4Box("mvhd", mvhdPayload),
    trak,
  ]));

  return Buffer.concat([
    mp4Box("ftyp", Buffer.from(`${brand}\0\0\0\0${compatibleBrand}mp42isom`, "ascii")),
    moov,
    mp4Box("mdat", Buffer.from([0, 1, 2, 3])),
  ]).toString("base64");
}

function mp4Box(type, payload) {
  const box = Buffer.alloc(8 + payload.length);
  box.writeUInt32BE(box.length, 0);
  box.write(type, 4, "ascii");
  payload.copy(box, 8);
  return box;
}

function base64UrlEncode(value) {
  return Buffer.from(JSON.stringify(value))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition was not met");
}

module.exports = {
  makeJWT,
  makeTestM4ABase64,
  makeTestWavBase64,
  tick,
  waitUntil,
};
