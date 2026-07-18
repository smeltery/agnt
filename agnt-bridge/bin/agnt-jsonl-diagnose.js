#!/usr/bin/env node
// FILE: agnt-jsonl-diagnose.js
// Purpose: Standalone diagnostic for Codex session JSONL history parsing.
//          Codex-specific — parses the rollout schema (session_meta,
//          event_msg, response_item) that providers/codex/session-jsonl-history.js
//          consumes at runtime. Other providers store their session histories in
//          provider-native formats (~/.claude/projects/*.jsonl with Claude's
//          schema, ~/.cursor/chats/*.jsonl with Cursor's schema, etc.) and need
//          their own diagnostics if they break.

const path = require("path");

const { diagnoseSessionJsonl } = require("../src/providers/codex/session-jsonl-diagnostics");

const DEFAULT_RECENT_TURN_LIMIT = 5;
const DEFAULT_TEXT_PREVIEW_CHARS = 180;

function main(argv) {
  const options = parseArgs(argv);
  if (options.help || !options.filePath) {
    printUsage();
    process.exit(options.help ? 0 : 1);
  }

  const absolutePath = path.resolve(options.filePath);
  const result = diagnoseSessionJsonl(absolutePath, options);
  console.log(JSON.stringify(result, null, 2));

  if (result.errors.file) {
    process.exit(2);
  }
  if (result.parse.invalidJsonLines > 0 || result.history.turnCount === 0) {
    process.exit(3);
  }
}

function parseArgs(argv) {
  const options = {
    filePath: "",
    recentTurns: DEFAULT_RECENT_TURN_LIMIT,
    previewChars: DEFAULT_TEXT_PREVIEW_CHARS,
    includeText: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") {
      options.help = true;
    } else if (arg === "--show-text") {
      options.includeText = true;
    } else if (arg === "--recent-turns") {
      options.recentTurns = readPositiveInteger(argv[index + 1], DEFAULT_RECENT_TURN_LIMIT);
      index += 1;
    } else if (arg === "--preview-chars") {
      options.previewChars = readPositiveInteger(argv[index + 1], DEFAULT_TEXT_PREVIEW_CHARS);
      index += 1;
    } else if (!options.filePath) {
      options.filePath = arg;
    }
  }

  return options;
}

function printUsage() {
  console.log([
    "Usage:",
    "  agnt-jsonl-diagnose /path/to/session.jsonl",
    "",
    "Options:",
    "  --recent-turns N    Number of recent parsed turns to summarize. Default: 5",
    "  --preview-chars N   Text preview length per item. Default: 180",
    "  --show-text         Include short text previews in the output",
  ].join("\n"));
}

function readPositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

if (require.main === module) {
  main(process.argv.slice(2));
}
