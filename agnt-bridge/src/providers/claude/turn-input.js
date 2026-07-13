// FILE: providers/claude/turn-input.js
// Purpose: Build Claude stream-json turn input from Codex turn/start params.
// Layer: provider plugin helper (claude)
// Exports: buildClaudeUserMessageLine, mapCodexEffortToClaude
// Depends on: ../_shared/translator-utils

const { readString } = require("../_shared/translator-utils");

function mapCodexEffortToClaude(level) {
  switch (level) {
    case "minimal":
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
    case "very_high":
    case "very-high":
      return "xhigh";
    case "max":
    case "maximum":
      return "max";
    default:
      return "";
  }
}

function buildClaudeUserMessageLine(params) {
  const items = Array.isArray(params?.input) ? params.input : [];
  const contentParts = [];
  let textBuffer = "";
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const t = readString(item.type);
    if (t === "text") {
      const text = readString(item.text);
      if (text) textBuffer += textBuffer ? `\n${text}` : text;
    } else if (t === "image") {
      const url = readString(item.image_url) || readString(item.url);
      if (url) contentParts.push({ type: "image", source: imageSourceFromUrl(url) });
    } else if (t === "skill") {
      const name = readString(item.name) || readString(item.id);
      if (name) textBuffer += `\n[skill: ${name}]`;
    } else if (t === "mention") {
      const name = readString(item.name);
      const p = readString(item.path);
      if (name && p) textBuffer += `\n@${name} (${p})`;
    }
  }
  if (textBuffer) contentParts.unshift({ type: "text", text: textBuffer });
  if (contentParts.length === 0) return "";
  return JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: contentParts.length === 1 && contentParts[0].type === "text"
        ? contentParts[0].text
        : contentParts,
    },
  });
}

function imageSourceFromUrl(url) {
  if (url.startsWith("data:")) {
    const match = /^data:([^;]+);base64,(.+)$/.exec(url);
    if (match) {
      return { type: "base64", media_type: match[1], data: match[2] };
    }
  }
  return { type: "url", url };
}

module.exports = {
  buildClaudeUserMessageLine,
  mapCodexEffortToClaude,
};
