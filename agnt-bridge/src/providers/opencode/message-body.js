const { readString } = require("../_shared/translator-utils");
const { inferImageMediaType } = require("./mappers");

function createOpencodeMessageBodyBuilder(state) {
function buildOpencodeMessageBody(params) {
  const items = Array.isArray(params?.input) ? params.input : [];
  const parts = [];
  let combinedText = "";
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const type = readString(item.type);
    if (type === "text") {
      const text = readString(item.text);
      if (text) combinedText += combinedText ? `\n${text}` : text;
    } else if (type === "image") {
      const url = readString(item.image_url) || readString(item.url);
      if (!url) continue;
      // opencode receives images as `{type:"file", mediaType, url}` parts.
      // The internal model adapter rewrites that to image_url for upstream
      // providers (verified in opencode 1.14.30 binary).
      const mediaType = inferImageMediaType(url);
      parts.push({ type: "file", mediaType, url });
    } else if (type === "skill") {
      const name = readString(item.name) || readString(item.id);
      if (name) combinedText += `\n[skill: ${name}]`;
    } else if (type === "mention") {
      const name = readString(item.name);
      const p = readString(item.path);
      if (name && p) combinedText += `\n@${name} (${p})`;
    }
  }
  if (combinedText) parts.unshift({ type: "text", text: combinedText });
  if (parts.length === 0) return null;

  const providerId = readString(params.providerID)
    || readString(params.provider)
    || state.lastProviderId
    || "anthropic";
  const modelId = readString(params.modelID)
    || readString(params.model)
    || state.lastModelId
    || "claude-haiku-4-5";
  state.lastProviderId = providerId;
  state.lastModelId = modelId;

  return {
    providerID: providerId,
    modelID: modelId,
    parts,
  };
}



  return { buildOpencodeMessageBody };
}

module.exports = {
  createOpencodeMessageBodyBuilder,
};
