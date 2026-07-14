const fs = require("fs");
const path = require("path");
const os = require("os");

function createCursorSessionStore({ env = process.env } = {}) {
function locateSessionFile(targetThreadId) {
  if (!targetThreadId) return "";
  const chatsDir = path.join(cursorHome(), "chats");
  const candidate = path.join(chatsDir, `${targetThreadId}.jsonl`);
  if (fs.existsSync(candidate)) return candidate;
  return "";
}

function listThreadSummaries() {
  const chatsDir = path.join(cursorHome(), "chats");
  let files;
  try {
    files = fs.readdirSync(chatsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const summaries = [];
  for (const file of files) {
    if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
    const id = file.name.slice(0, -".jsonl".length);
    let stat;
    try {
      stat = fs.statSync(path.join(chatsDir, file.name));
    } catch {
      continue;
    }
    summaries.push({
      id,
      threadId: id,
      thread_id: id,
      status: "idle",
      updatedAt: stat.mtimeMs,
      createdAt: stat.birthtimeMs || stat.ctimeMs,
    });
  }
  summaries.sort((a, b) => b.updatedAt - a.updatedAt);
  return summaries.slice(0, 200);
}

function cursorHome() {
  return env.CURSOR_HOME || path.join(os.homedir(), ".cursor");
}


  return {
    locateSessionFile,
    listThreadSummaries,
  };
}

module.exports = {
  createCursorSessionStore,
};
