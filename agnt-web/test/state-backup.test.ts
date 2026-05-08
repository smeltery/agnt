// Backup/restore contract: the export skips identity + pairing keys, the
// schema-version gate rejects payloads we can't read, and an apply round-trip
// preserves the values we write.

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the idb module before importing the lib under test so the helper
// reads/writes our in-memory map instead of the real IndexedDB (vitest runs
// in a node-like env where IndexedDB isn't available).
const memory = new Map<string, unknown>();
vi.mock("../src/storage/idb", () => ({
  idb: {
    async get<T>(key: string): Promise<T | undefined> {
      return memory.has(key) ? (memory.get(key) as T) : undefined;
    },
    async set<T>(key: string, value: T): Promise<void> {
      memory.set(key, value);
    },
    async remove(key: string): Promise<void> {
      memory.delete(key);
    },
    async keys(): Promise<string[]> {
      return [...memory.keys()];
    },
  },
}));

import {
  applyStateBackup,
  buildStateBackup,
  isBackupKey,
  parseStateBackup,
} from "../src/lib/state-backup";

beforeEach(() => {
  memory.clear();
});

describe("isBackupKey", () => {
  it("admits the prefs.* and messages:* prefixes", () => {
    expect(isBackupKey("prefs.theme")).toBe(true);
    expect(isBackupKey("messages:thread-1")).toBe(true);
  });
  it("rejects identity / pairing / unknown keys", () => {
    expect(isBackupKey("phoneIdentity")).toBe(false);
    expect(isBackupKey("relayPairing")).toBe(false);
    expect(isBackupKey("trustedMacRegistry")).toBe(false);
    expect(isBackupKey("randomKey")).toBe(false);
  });
});

describe("buildStateBackup", () => {
  it("includes only allow-listed keys", async () => {
    memory.set("prefs.theme", "dark");
    memory.set("prefs.pinnedThreadIds", ["a", "b"]);
    memory.set("messages:thread-1", [{ id: "m1" }]);
    memory.set("phoneIdentity", { secret: "REDACTED" });
    memory.set("relayPairing", { sessionId: "x" });
    memory.set("trustedMacRegistry", { records: {} });

    const backup = await buildStateBackup();
    expect(backup.schemaVersion).toBe(1);
    expect(Object.keys(backup.kv).sort()).toEqual([
      "messages:thread-1",
      "prefs.pinnedThreadIds",
      "prefs.theme",
    ]);
    expect(backup.kv["prefs.theme"]).toBe("dark");
  });

  it("emits a sortable ISO timestamp", async () => {
    const backup = await buildStateBackup();
    expect(() => new Date(backup.exportedAt).toISOString()).not.toThrow();
  });
});

describe("parseStateBackup", () => {
  it("rejects non-object payloads", () => {
    expect(parseStateBackup(null).ok).toBe(false);
    expect(parseStateBackup("nope").ok).toBe(false);
  });
  it("rejects unsupported schemaVersion", () => {
    expect(parseStateBackup({ schemaVersion: 999, kv: {} }).ok).toBe(false);
  });
  it("requires a kv object", () => {
    expect(parseStateBackup({ schemaVersion: 1 }).ok).toBe(false);
    expect(parseStateBackup({ schemaVersion: 1, kv: [] }).ok).toBe(false);
  });
});

describe("applyStateBackup", () => {
  it("writes allow-listed keys and counts skips", async () => {
    const result = await applyStateBackup({
      schemaVersion: 1,
      kv: {
        "prefs.theme": "light",
        "messages:thread-2": [{ id: "x" }],
        phoneIdentity: { stolen: true },
        rogue: "value",
      },
    });
    expect(result.ok).toBe(true);
    expect(result.appliedCount).toBe(2);
    expect(result.skippedCount).toBe(2);
    expect(memory.get("prefs.theme")).toBe("light");
    expect(memory.get("messages:thread-2")).toEqual([{ id: "x" }]);
    expect(memory.get("phoneIdentity")).toBeUndefined();
    expect(memory.get("rogue")).toBeUndefined();
  });

  it("returns an error result on bad payloads", async () => {
    const result = await applyStateBackup("oops");
    expect(result.ok).toBe(false);
    expect(typeof result.reason).toBe("string");
  });

  it("round-trips an export through an import", async () => {
    memory.set("prefs.theme", "dark");
    memory.set("prefs.pinnedThreadIds", ["a"]);
    const exported = await buildStateBackup();
    memory.clear();
    const result = await applyStateBackup(exported);
    expect(result.ok).toBe(true);
    expect(memory.get("prefs.theme")).toBe("dark");
    expect(memory.get("prefs.pinnedThreadIds")).toEqual(["a"]);
  });
});
