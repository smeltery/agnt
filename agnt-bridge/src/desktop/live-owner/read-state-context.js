const { createHash } = require("node:crypto");
const { readString } = require("../desktop-ipc-shared");

function buildThreadReadStateContext(authStatus, hostId = "local") {
  if (!authStatus || hostId !== "local") {
    return null;
  }
  let identity;
  if (authStatus.authMethod === "chatgpt" || authStatus.authMethod === "chatgptAuthTokens") {
    try {
      const payload = JSON.parse(Buffer.from(
        readString(authStatus.authToken).split(".")[1] || "", "base64url"
      ).toString("utf8"));
      const auth = payload["https://api.openai.com/auth"];
      const accountId = readString(auth?.chatgpt_account_id ?? auth?.account_id);
      const userId = readString(auth?.user_id ?? auth?.chatgpt_user_id);
      if (!accountId || !userId) {
        return null;
      }
      identity = { kind: "chatgpt", accountId, userId };
    } catch {
      return null;
    }
  } else {
    if (authStatus.authMethod == null && authStatus.requiresOpenaiAuth !== false) {
      return null;
    }
    identity = { kind: "execution-storage", authMode: authStatus.authMethod ?? "none" };
  }
  const hostHash = createHash("sha256").update(JSON.stringify(["local", hostId, null])).digest("hex");
  return { identity, executionHostKey: `${hostId}:${hostHash}` };
}


module.exports = { buildThreadReadStateContext };
