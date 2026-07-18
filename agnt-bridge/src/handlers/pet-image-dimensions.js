// FILE: pet-image-dimensions.js
// Purpose: Reads PNG/WebP dimensions for local pet spritesheet validation.
// Layer: Bridge handler support

async function readImageDimensionsFromFile(file, mimeType, fileSize) {
  if (mimeType === "image/png") {
    return pngDimensions(await readFileSlice(file, 0, 24));
  }
  if (mimeType === "image/webp") {
    return readWebPDimensionsFromFile(file, fileSize);
  }
  return null;
}

async function readWebPDimensionsFromFile(file, fileSize) {
  const riffHeader = await readFileSlice(file, 0, 12);
  if (
    riffHeader.length < 12
    || riffHeader.toString("ascii", 0, 4) !== "RIFF"
    || riffHeader.toString("ascii", 8, 12) !== "WEBP"
  ) {
    return null;
  }

  let offset = 12;
  while (offset + 8 <= fileSize) {
    const chunkHeader = await readFileSlice(file, offset, 8);
    if (chunkHeader.length < 8) {
      return null;
    }

    const chunkType = chunkHeader.toString("ascii", 0, 4);
    const chunkSize = chunkHeader.readUInt32LE(4);
    const payloadOffset = offset + 8;
    if (payloadOffset + chunkSize > fileSize) {
      return null;
    }

    const dimensionsPayloadLength = webpDimensionsPayloadLength(chunkType);
    if (dimensionsPayloadLength > 0) {
      const payload = await readFileSlice(file, payloadOffset, Math.min(chunkSize, dimensionsPayloadLength));
      const chunkBuffer = Buffer.concat([chunkHeader, payload]);
      const dimensions = webpChunkDimensions(chunkBuffer, chunkType, 8, chunkSize);
      if (dimensions) {
        return dimensions;
      }
    }

    offset = payloadOffset + chunkSize + (chunkSize % 2);
  }

  return null;
}

function webpDimensionsPayloadLength(chunkType) {
  if (chunkType === "VP8X") {
    return 10;
  }
  if (chunkType === "VP8L") {
    return 5;
  }
  if (chunkType === "VP8 ") {
    return 10;
  }
  return 0;
}

async function readFileSlice(file, offset, length) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await file.read(buffer, 0, length, offset);
  return buffer.subarray(0, bytesRead);
}

function imageDimensions(data, mimeType) {
  if (mimeType === "image/png") {
    return pngDimensions(data);
  }
  if (mimeType === "image/webp") {
    return webpDimensions(data);
  }
  return null;
}

function pngDimensions(data) {
  if (data.length < 24 || data.readUInt32BE(0) !== 0x89504e47 || data.readUInt32BE(4) !== 0x0d0a1a0a) {
    return null;
  }
  return {
    width: data.readUInt32BE(16),
    height: data.readUInt32BE(20),
  };
}

function webpDimensions(data) {
  if (
    data.length < 30
    || data.toString("ascii", 0, 4) !== "RIFF"
    || data.toString("ascii", 8, 12) !== "WEBP"
  ) {
    return null;
  }

  let offset = 12;
  while (offset + 8 <= data.length) {
    const chunkType = data.toString("ascii", offset, offset + 4);
    const chunkSize = data.readUInt32LE(offset + 4);
    const payloadOffset = offset + 8;
    if (payloadOffset + chunkSize > data.length) {
      return null;
    }

    const dimensions = webpChunkDimensions(data, chunkType, payloadOffset, chunkSize);
    if (dimensions) {
      return dimensions;
    }

    offset = payloadOffset + chunkSize + (chunkSize % 2);
  }

  return null;
}

function webpChunkDimensions(data, chunkType, payloadOffset, chunkSize) {
  if (chunkType === "VP8X" && chunkSize >= 10) {
    return {
      width: readUInt24LE(data, payloadOffset + 4) + 1,
      height: readUInt24LE(data, payloadOffset + 7) + 1,
    };
  }

  if (chunkType === "VP8L" && chunkSize >= 5 && data[payloadOffset] === 0x2f) {
    const bits = data.readUInt32LE(payloadOffset + 1);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }

  if (chunkType === "VP8 " && chunkSize >= 10) {
    const startCodeOffset = payloadOffset + 3;
    if (
      data[startCodeOffset] !== 0x9d
      || data[startCodeOffset + 1] !== 0x01
      || data[startCodeOffset + 2] !== 0x2a
    ) {
      return null;
    }

    return {
      width: data.readUInt16LE(payloadOffset + 6) & 0x3fff,
      height: data.readUInt16LE(payloadOffset + 8) & 0x3fff,
    };
  }

  return null;
}

function readUInt24LE(data, offset) {
  return data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16);
}

module.exports = {
  imageDimensions,
  readImageDimensionsFromFile,
};
