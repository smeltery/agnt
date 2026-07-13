// FILE: voice-audio.js
// Purpose: Pure WAV and M4A container checks for bridge-proxied voice clips.
// Layer: Bridge handler helper
// Exports: readVoiceAudioInfo
// Depends on: Buffer

const WAV_MIME_TYPE = "audio/wav";
const M4A_MIME_TYPE = "audio/mp4";

function readVoiceAudioInfo(buffer, mimeType) {
  if (mimeType === WAV_MIME_TYPE) {
    return readWavAudioInfo(buffer);
  }
  if (mimeType === M4A_MIME_TYPE) {
    return readM4AAudioInfo(buffer);
  }
  return null;
}

function readWavAudioInfo(buffer) {
  const wavInfo = readWavInfo(buffer);
  if (!wavInfo || !isSupportedVoiceWav(wavInfo)) {
    return null;
  }
  return {
    durationMs: (wavInfo.dataByteCount / wavInfo.byteRate) * 1_000,
    filename: "voice.wav",
  };
}

function readWavInfo(buffer) {
  if (!isRiffWave(buffer)) {
    return null;
  }

  let offset = 12;
  let format = null;
  let dataByteCount = 0;
  while (offset + 8 <= buffer.length) {
    const chunkID = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const payloadStart = offset + 8;
    const payloadEnd = payloadStart + chunkSize;
    if (payloadEnd > buffer.length) {
      return null;
    }

    if (chunkID === "fmt ") {
      if (chunkSize < 16) {
        return null;
      }
      format = {
        audioFormat: buffer.readUInt16LE(payloadStart),
        channelCount: buffer.readUInt16LE(payloadStart + 2),
        sampleRateHz: buffer.readUInt32LE(payloadStart + 4),
        byteRate: buffer.readUInt32LE(payloadStart + 8),
        blockAlign: buffer.readUInt16LE(payloadStart + 12),
        bitsPerSample: buffer.readUInt16LE(payloadStart + 14),
      };
    } else if (chunkID === "data") {
      dataByteCount = chunkSize;
    }

    offset = payloadEnd + (chunkSize % 2);
  }

  return format && dataByteCount > 0
    ? { ...format, dataByteCount }
    : null;
}

function isRiffWave(buffer) {
  return Buffer.isBuffer(buffer)
    && buffer.length >= 44
    && buffer.toString("ascii", 0, 4) === "RIFF"
    && buffer.toString("ascii", 8, 12) === "WAVE";
}

function isSupportedVoiceWav(wavInfo) {
  return wavInfo.audioFormat === 1
    && wavInfo.channelCount === 1
    && wavInfo.sampleRateHz === 24_000
    && wavInfo.bitsPerSample === 16
    && wavInfo.blockAlign === 2
    && wavInfo.byteRate === 48_000;
}

function readM4AAudioInfo(buffer) {
  const m4aInfo = readM4AInfo(buffer);
  return m4aInfo
    ? { durationMs: m4aInfo.durationMs, filename: "voice.m4a" }
    : null;
}

function readM4AInfo(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) {
    return null;
  }

  let hasM4ABrand = false;
  let hasMediaData = false;
  let movieDurationMs = NaN;
  let audioTrack = null;
  for (const box of readMp4Boxes(buffer, 0, buffer.length)) {
    if (box.type === "ftyp") {
      hasM4ABrand = isM4AFileTypeBox(buffer, box);
    } else if (box.type === "mdat") {
      hasMediaData = box.payloadEnd > box.payloadStart;
    } else if (box.type === "moov") {
      movieDurationMs = readMovieDurationMs(buffer, box.payloadStart, box.payloadEnd);
      audioTrack = readAudioTrackInfo(buffer, box.payloadStart, box.payloadEnd);
    }
  }

  if (
    !hasM4ABrand
    || !hasMediaData
    || !Number.isFinite(movieDurationMs)
    || movieDurationMs <= 0
    || !isSupportedM4AAudioTrack(audioTrack)
  ) {
    return null;
  }

  return { durationMs: Math.max(movieDurationMs, audioTrack.durationMs) };
}

function* readMp4Boxes(buffer, start, end) {
  let offset = start;
  while (offset + 8 <= end) {
    const size32 = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    let headerSize = 8;
    let size = size32;
    if (size32 === 1) {
      if (offset + 16 > end) {
        return;
      }
      const size64 = buffer.readBigUInt64BE(offset + 8);
      if (size64 > BigInt(Number.MAX_SAFE_INTEGER)) {
        return;
      }
      size = Number(size64);
      headerSize = 16;
    } else if (size32 === 0) {
      size = end - offset;
    }
    if (size < headerSize || offset + size > end) {
      return;
    }

    yield {
      type,
      payloadStart: offset + headerSize,
      payloadEnd: offset + size,
    };
    offset += size;
  }
}

function isM4AFileTypeBox(buffer, box) {
  if (box.payloadEnd - box.payloadStart < 8) {
    return false;
  }
  const brands = [
    buffer.toString("ascii", box.payloadStart, box.payloadStart + 4),
  ];
  for (let offset = box.payloadStart + 8; offset + 4 <= box.payloadEnd; offset += 4) {
    brands.push(buffer.toString("ascii", offset, offset + 4));
  }
  return brands.includes("M4A ");
}

function readMovieDurationMs(buffer, start, end) {
  for (const box of readMp4Boxes(buffer, start, end)) {
    if (box.type === "mvhd") {
      return readFullBoxDurationMs(buffer, box.payloadStart, box.payloadEnd);
    }
  }
  return NaN;
}

function readAudioTrackInfo(buffer, start, end) {
  for (const box of readMp4Boxes(buffer, start, end)) {
    if (box.type !== "trak") {
      continue;
    }
    const trackInfo = readTrackInfo(buffer, box.payloadStart, box.payloadEnd);
    if (trackInfo.handlerType === "soun") {
      return trackInfo;
    }
  }
  return null;
}

function readTrackInfo(buffer, start, end) {
  const trackInfo = {
    durationMs: NaN,
    handlerType: "",
    sampleEntry: null,
  };
  for (const box of readMp4Boxes(buffer, start, end)) {
    if (box.type !== "mdia") {
      continue;
    }
    for (const mediaBox of readMp4Boxes(buffer, box.payloadStart, box.payloadEnd)) {
      if (mediaBox.type === "mdhd") {
        trackInfo.durationMs = readFullBoxDurationMs(buffer, mediaBox.payloadStart, mediaBox.payloadEnd);
      } else if (mediaBox.type === "hdlr") {
        trackInfo.handlerType = readHandlerType(buffer, mediaBox.payloadStart, mediaBox.payloadEnd);
      } else if (mediaBox.type === "minf") {
        trackInfo.sampleEntry = readAudioSampleEntry(buffer, mediaBox.payloadStart, mediaBox.payloadEnd);
      }
    }
  }
  return trackInfo;
}

function readFullBoxDurationMs(buffer, start, end) {
  if (start + 4 > end) {
    return NaN;
  }
  const version = buffer.readUInt8(start);
  if (version === 0) {
    if (start + 20 > end) {
      return NaN;
    }
    return durationMs(buffer.readUInt32BE(start + 12), buffer.readUInt32BE(start + 16));
  }
  if (version === 1) {
    if (start + 32 > end) {
      return NaN;
    }
    const duration = buffer.readBigUInt64BE(start + 24);
    if (duration > BigInt(Number.MAX_SAFE_INTEGER)) {
      return NaN;
    }
    return durationMs(buffer.readUInt32BE(start + 20), Number(duration));
  }
  return NaN;
}

function durationMs(timescale, duration) {
  if (!Number.isFinite(timescale) || timescale <= 0 || !Number.isFinite(duration) || duration <= 0) {
    return NaN;
  }
  return (duration / timescale) * 1_000;
}

function readHandlerType(buffer, start, end) {
  return start + 12 <= end ? buffer.toString("ascii", start + 8, start + 12) : "";
}

function readAudioSampleEntry(buffer, start, end) {
  for (const minfBox of readMp4Boxes(buffer, start, end)) {
    if (minfBox.type !== "stbl") {
      continue;
    }
    for (const stblBox of readMp4Boxes(buffer, minfBox.payloadStart, minfBox.payloadEnd)) {
      if (stblBox.type !== "stsd" || stblBox.payloadStart + 16 > stblBox.payloadEnd) {
        continue;
      }
      const entryCount = buffer.readUInt32BE(stblBox.payloadStart + 4);
      const sampleEntryStart = stblBox.payloadStart + 8;
      if (entryCount < 1 || sampleEntryStart + 8 > stblBox.payloadEnd) {
        continue;
      }

      const sampleEntrySize = buffer.readUInt32BE(sampleEntryStart);
      const sampleEntryType = buffer.toString("ascii", sampleEntryStart + 4, sampleEntryStart + 8);
      if (
        sampleEntryType !== "mp4a"
        || sampleEntryStart + sampleEntrySize > stblBox.payloadEnd
        || sampleEntryStart + 36 > stblBox.payloadEnd
      ) {
        continue;
      }
      return {
        codec: sampleEntryType,
        channelCount: buffer.readUInt16BE(sampleEntryStart + 24),
        sampleSize: buffer.readUInt16BE(sampleEntryStart + 26),
        sampleRateHz: buffer.readUInt32BE(sampleEntryStart + 32) >>> 16,
      };
    }
  }
  return null;
}

function isSupportedM4AAudioTrack(trackInfo) {
  const sampleEntry = trackInfo?.sampleEntry;
  return trackInfo
    && Number.isFinite(trackInfo.durationMs)
    && trackInfo.durationMs > 0
    && sampleEntry?.codec === "mp4a"
    && (sampleEntry.channelCount === 1 || sampleEntry.channelCount === 2)
    && sampleEntry.sampleSize === 16
    && sampleEntry.sampleRateHz === 24_000;
}

module.exports = {
  readVoiceAudioInfo,
};
