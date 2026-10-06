import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const browser = process.argv[2];
if (!browser) {
  console.error("Usage: node agnt-site/brand/render-og.mjs /path/to/chromium");
  process.exit(1);
}

const profile = mkdtempSync(join(tmpdir(), "agnt-og-"));
try {
  const result = spawnSync(
    browser,
    [
      "--headless",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      "--force-device-scale-factor=1",
      "--window-size=1200,630",
      "--virtual-time-budget=1000",
      `--user-data-dir=${profile}`,
      `--screenshot=${fileURLToPath(new URL("../assets/og.png", import.meta.url))}`,
      new URL("./og.html", import.meta.url).href,
    ],
    { stdio: "inherit", timeout: 30_000 },
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`Chromium exited with status ${result.status}`);
} finally {
  rmSync(profile, { recursive: true, force: true });
}
