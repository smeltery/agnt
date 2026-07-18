#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

const budgetPath = process.argv[2] ?? "scripts/loc-budgets.json";
const budget = JSON.parse(readFileSync(budgetPath, "utf8"));

const ignoredPathPattern = /(^|\/)(node_modules|target|dist|build|deps|_build|site|fixtures|vendor|\.git|run-pet|Assets\.xcassets|Fonts|Resources\/Mermaid|app\/src\/main\/assets|\.xcframework)(\/|$)/;
const ignoredExtensionPattern = /\.(a|gif|icns|jpeg|jpg|png|ttf|webp)$/i;
const checkedExtensionPattern = /\.(css|html|js|json|jsx|kt|kts|mjs|md|rs|sh|swift|toml|ts|tsx|yml|yaml)$/i;

function trackedFiles() {
  return execFileSync("git", ["ls-files"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .filter((file) => {
      if (ignoredPathPattern.test(file) || ignoredExtensionPattern.test(file)) return false;
      return checkedExtensionPattern.test(file);
    });
}

function lineCount(file) {
  const content = readFileSync(file, "utf8");
  if (content.length === 0) return 0;
  return content.endsWith("\n") ? content.split("\n").length - 1 : content.split("\n").length;
}

function directDirectoryCounts(files) {
  const counts = new Map();
  for (const file of files) {
    const lastSlash = file.lastIndexOf("/");
    const dir = lastSlash === -1 ? "." : file.slice(0, lastSlash);
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  return counts;
}

const files = trackedFiles().filter((file) => {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
});

const sizeBudget = budget.file_sizes ?? {};
const defaultLines = Number(sizeBudget.default_lines ?? 1000);
const fileExceptions = sizeBudget.files ?? {};
const flatBudget = budget.flat_directories ?? {};
const defaultFiles = Number(flatBudget.default_files ?? 25);
const directoryExceptions = flatBudget.directories ?? {};

const failures = [];

for (const file of files) {
  const actual = lineCount(file);
  const limit = Number(fileExceptions[file] ?? defaultLines);
  if (actual > limit) {
    failures.push(`${file}: ${actual} lines > budget ${limit}`);
  }
}

for (const [dir, actual] of directDirectoryCounts(files)) {
  const exception = directoryExceptions[dir];
  const limit = Number(typeof exception === "object" ? exception.limit : exception ?? defaultFiles);
  if (actual > limit) {
    failures.push(`${dir}: ${actual} direct files > budget ${limit}`);
  }
}

if (failures.length > 0) {
  console.error("LOC budget failures:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`LOC budgets passed for ${files.length} tracked text files.`);
