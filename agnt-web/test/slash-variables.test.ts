// Slash variable expansion: known tokens resolve, unknown tokens stay
// intact so users notice typos, date/time use local-time formatting.

import { describe, expect, it } from "vitest";
import { expandSlashVariables } from "../src/lib/slash-variables";

const FROZEN = new Date(2026, 0, 15, 9, 30); // Jan 15 2026 09:30 local

describe("expandSlashVariables", () => {
  it("resolves cwd, thread title, and selection from context", () => {
    const out = expandSlashVariables(
      "Status for {thread} in {cwd}: {selection}",
      { cwd: "/repo", threadTitle: "Refactor auth", selection: "audit token TTLs", now: FROZEN }
    );
    expect(out).toBe("Status for Refactor auth in /repo: audit token TTLs");
  });

  it("falls back to empty for known-but-missing context entries", () => {
    expect(expandSlashVariables("cwd={cwd}", { now: FROZEN })).toBe("cwd=");
  });

  it("leaves unknown tokens intact so typos are visible", () => {
    expect(expandSlashVariables("{whoops}", { now: FROZEN })).toBe("{whoops}");
  });

  it("formats {date} as YYYY-MM-DD in local time", () => {
    expect(expandSlashVariables("{date}", { now: FROZEN })).toBe("2026-01-15");
  });

  it("formats {time} as HH:MM zero-padded", () => {
    expect(expandSlashVariables("{time}", { now: FROZEN })).toBe("09:30");
  });

  it("matches tokens case-insensitively", () => {
    expect(expandSlashVariables("{CWD}", { cwd: "/r", now: FROZEN })).toBe("/r");
  });

  it("preserves surrounding text exactly", () => {
    expect(expandSlashVariables("a {date} b", { now: FROZEN })).toBe("a 2026-01-15 b");
  });
});
