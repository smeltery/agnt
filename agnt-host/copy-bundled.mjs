// copy-bundled.mjs - Copies relay and agnt-bridge source files into src-tauri/bundled/
import { createHash } from "crypto";
import {
  cpSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

function copyDir(src, dest, excludeDirs = []) {
  if (!existsSync(src)) return;
  cpSync(src, dest, {
    recursive: true,
    filter: (filePath) => {
      return !excludeDirs.some((dir) => filePath.split(/[/\\]/).includes(dir));
    },
  });
}

function readPackageMetadata(dir) {
  const packageJsonPath = join(dir, "package.json");
  if (!existsSync(packageJsonPath)) return null;
  const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  return {
    name: typeof parsed.name === "string" ? parsed.name : null,
    version: typeof parsed.version === "string" ? parsed.version : null,
  };
}

function hashDir(dir) {
  const hash = createHash("sha256");
  const files = [];

  function walk(current, relative = "") {
    for (const entry of readdirSync(current).sort()) {
      const fullPath = join(current, entry);
      const relativePath = relative ? `${relative}/${entry}` : entry;
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        walk(fullPath, relativePath);
      } else if (stat.isFile()) {
        files.push({ fullPath, relativePath });
      }
    }
  }

  if (existsSync(dir)) walk(dir);

  for (const file of files.sort((a, b) => a.relativePath.localeCompare(b.relativePath))) {
    hash.update(file.relativePath);
    hash.update("\0");
    hash.update(readFileSync(file.fullPath));
    hash.update("\0");
  }

  return hash.digest("hex");
}

const bundledDir = join(__dirname, "src-tauri", "bundled");
rmSync(bundledDir, { recursive: true, force: true });

console.log("Copying relay sources...");
copyDir(
  join(repoRoot, "relay"),
  join(bundledDir, "relay"),
  ["node_modules", ".git"],
);

console.log("Copying agnt-bridge sources...");
copyDir(
  join(repoRoot, "agnt-bridge"),
  join(bundledDir, "agnt-bridge"),
  ["node_modules", ".git"],
);

const relayDir = join(bundledDir, "relay");
const bridgeDir = join(bundledDir, "agnt-bridge");
const manifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  relay: {
    package: readPackageMetadata(relayDir),
    hash: hashDir(relayDir),
  },
  bridge: {
    package: readPackageMetadata(bridgeDir),
    hash: hashDir(bridgeDir),
  },
};

writeFileSync(
  join(bundledDir, "agnt-bundle.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

console.log("Bundled files copied.");
