// FILE: workspace-revert-patch-analysis.js
// Purpose: Parses unified patch metadata for workspace revert previews.
// Layer: Bridge handler helper

function analyzeUnifiedPatch(rawPatch) {
  const patch = rawPatch.trim();
  if (!patch) {
    return {
      affectedFiles: [],
      unsupportedReasons: ["No exact patch was captured."],
    };
  }

  const chunks = splitPatchIntoChunks(patch);
  if (!chunks.length) {
    return {
      affectedFiles: [],
      unsupportedReasons: ["No exact patch was captured."],
    };
  }

  const affectedFiles = [];
  const unsupportedReasons = new Set();

  for (const chunk of chunks) {
    const analysis = analyzePatchChunk(chunk);
    if (analysis.path) {
      affectedFiles.push(analysis.path);
    }
    for (const reason of analysis.unsupportedReasons) {
      unsupportedReasons.add(reason);
    }
  }

  if (!affectedFiles.length) {
    unsupportedReasons.add("No exact patch was captured.");
  }

  return {
    affectedFiles: [...new Set(affectedFiles)].sort(),
    unsupportedReasons: [...unsupportedReasons].sort(),
  };
}

function splitPatchIntoChunks(patch) {
  const lines = patch.split("\n");
  if (!lines.length) {
    return [];
  }

  const chunks = [];
  let current = [];

  for (const line of lines) {
    if (line.startsWith("diff --git ") && current.length) {
      chunks.push(current);
      current = [];
    }
    current.push(line);
  }

  if (current.length) {
    chunks.push(current);
  }

  return chunks;
}

function analyzePatchChunk(lines) {
  const patchPath = extractPatchPath(lines);
  const isBinary = lines.some((line) => line.startsWith("Binary files ") || line === "GIT binary patch");
  const isRenameOrModeOnly = lines.some((line) =>
    line.startsWith("rename from ")
      || line.startsWith("rename to ")
      || line.startsWith("copy from ")
      || line.startsWith("copy to ")
      || line.startsWith("old mode ")
      || line.startsWith("new mode ")
      || line.startsWith("similarity index ")
      || line.startsWith("new file mode 120")
      || line.startsWith("deleted file mode 120")
  );

  let additions = 0;
  let deletions = 0;
  for (const line of lines) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      additions += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      deletions += 1;
    }
  }

  const unsupportedReasons = [];
  if (isBinary) {
    unsupportedReasons.push("Binary changes are not auto-revertable in v1.");
  }
  if (isRenameOrModeOnly) {
    unsupportedReasons.push("Rename, mode-only, or symlink changes are not auto-revertable in v1.");
  }
  if (!patchPath || (!additions && !deletions && !lines.includes("--- /dev/null") && !lines.includes("+++ /dev/null"))) {
    if (!isBinary && !isRenameOrModeOnly) {
      unsupportedReasons.push("No exact patch was captured.");
    }
  }

  return { path: patchPath, unsupportedReasons };
}

function extractPatchPath(lines) {
  for (const line of lines) {
    if (line.startsWith("+++ ")) {
      const normalized = normalizeDiffPath(line.slice(4).trim());
      if (normalized && normalized !== "/dev/null") {
        return normalized;
      }
    }
  }

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      const components = line.trim().split(/\s+/);
      if (components.length >= 4) {
        return normalizeDiffPath(components[3]);
      }
    }
  }

  return "";
}

function normalizeDiffPath(rawPath) {
  if (!rawPath) {
    return "";
  }

  if (rawPath.startsWith("a/") || rawPath.startsWith("b/")) {
    return rawPath.slice(2);
  }

  return rawPath;
}

module.exports = {
  analyzeUnifiedPatch,
};
