// Capture the shipped browser UI with deterministic example data, never a live session.
// Usage: node agnt-site/brand/render-product.mjs /path/to/playwright/index.mjs [dev-url]
import { mkdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const modulePath = process.argv[2];
if (!modulePath) throw new Error("Pass the path to an installed playwright/index.mjs");
const { chromium } = await import(pathToFileURL(modulePath).href);
const origin = process.argv[3] || "http://127.0.0.1:5173";
if (!["localhost", "127.0.0.1"].includes(new URL(origin).hostname)) {
  throw new Error("Use a local agnt-web Vite server; never seed a live deployment");
}
const output = new URL("../assets/screenshots/", import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  for (const [name, width, height] of [["browser-desktop", 1440, 1000], ["browser-mobile", 430, 932]]) {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, colorScheme: "light", locale: "en-US", timezoneId: "UTC" });
    const page = await context.newPage();
    const errors = [];
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    page.on("pageerror", (error) => { errors.push(error.message); console.error(error.message); });
    await page.goto(origin);
    await page.waitForFunction(async () => {
      const { useConnectionStore } = await import("/src/state/connection-store.ts");
      return !useConnectionStore.getState().bootstrapping;
    }, null, { timeout: 15000 });
    await page.evaluate(async () => {
      const [{ useConnectionStore }, { useThreadsStore }, { useAccountStore }, { emptyThreadState }, { createMessage }] = await Promise.all([
        import("/src/state/connection-store.ts"), import("/src/state/threads-store.ts"),
        import("/src/state/account-store.ts"), import("/src/state/turn-reducer.ts"), import("/src/models/message.ts"),
      ]);
      const now = Date.now();
      const id = "example-theme";
      const threads = [
        { id, title: "Make room for dark mode", cwd: "/projects/fieldnotes" },
        { id: "example-nav", title: "Tidy up the navigation", cwd: "/projects/fieldnotes" },
        { id: "example-search", title: "A faster search", cwd: "/projects/personal-site" },
      ].map((thread, index) => ({ ...thread, syncState: "live", createdAt: now - 600000, updatedAt: now - index * 60000 }));
      const rows = [
        { role: "user", text: "Add a dark theme that follows my system settings." },
        { role: "assistant", text: "I’ll use the existing color tokens and respect your system preference." },
        { role: "user", text: "Nice. Add a manual toggle, too." },
        { role: "assistant", text: "Added a theme toggle to the header. Your choice persists between visits.\n\n- Follows your system theme by default\n- Saves your manual preference\n- Includes an accessible toggle label\n\n```css\n@media (prefers-color-scheme: dark) {\n  :root {\n    --surface: #1c1d1b;\n    --text: #f5f5f2;\n  }\n}\n```" },
      ].map((row, index) => createMessage({ ...row, id: `example-message-${index}`, threadId: id, turnId: "example-turn", createdAt: now - 60000 + index * 1000 }));
      useAccountStore.setState({ snapshot: { providerId: "claude", loggedIn: true } });
      useThreadsStore.setState({ threads, selectedThreadId: id, hydrated: true, loading: false,
        reducerStates: { [id]: { ...emptyThreadState(), messages: rows } },
        lastVisitedByThread: Object.fromEntries(threads.map((thread) => [thread.id, now])),
      });
      // No Connection instance, identity keys, relay or agent requests are created.
      useConnectionStore.setState({ bootstrapping: false, saved: { relayUrl: "ws://127.0.0.1:8787", macDeviceId: "example-host", sessionId: "example-only" }, status: { kind: "open" } });
    });

    await page.locator(".agnt-workspace").waitFor({ timeout: 3000 });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(500);
    if (errors.length) throw new Error(errors.join("\n"));
    await page.screenshot({ path: fileURLToPath(new URL(`${name}.png`, output)) });
    await context.close();
  }
} finally {
  await browser.close();
}
