const fs = require("fs");
const path = require("path");
const os = require("os");

function createClaudeSessionStore({ env = process.env } = {}) {
  function locateSessionFile(targetThreadId) {
    if (!targetThreadId) return "";
    const projectsDir = path.join(claudeHome(), "projects");
    let entries;
    try {
      entries = fs.readdirSync(projectsDir, { withFileTypes: true });
    } catch {
      return "";
    }
    for (const dirent of entries) {
      if (!dirent.isDirectory()) continue;
      const candidate = path.join(projectsDir, dirent.name, `${targetThreadId}.jsonl`);
      if (fs.existsSync(candidate)) return candidate;
    }
    return "";
  }

  function listThreadSummaries() {
    const projectsDir = path.join(claudeHome(), "projects");
    let projects;
    try {
      projects = fs.readdirSync(projectsDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const summaries = [];
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      let files;
      try {
        files = fs.readdirSync(path.join(projectsDir, project.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
        const id = file.name.slice(0, -".jsonl".length);
        let stat;
        try {
          stat = fs.statSync(path.join(projectsDir, project.name, file.name));
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
    }
    summaries.sort((a, b) => b.updatedAt - a.updatedAt);
    return summaries.slice(0, 200);
  }

  function claudeHome() {
    return env.CLAUDE_HOME || path.join(os.homedir(), ".claude");
  }

  return {
    claudeHome,
    listThreadSummaries,
    locateSessionFile,
  };
}

module.exports = {
  createClaudeSessionStore,
};
