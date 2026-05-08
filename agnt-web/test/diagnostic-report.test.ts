// Diagnostic report: report shape, hash redaction, and the `pickPrefix`
// bucketing.

import { beforeEach, describe, expect, it, vi } from "vitest";

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
  buildDiagnosticReport,
  DIAGNOSTIC_SCHEMA_VERSION,
  shortHash,
} from "../src/lib/diagnostic-report";
import { useConnectionStore } from "../src/state/connection-store";
import { useLatencyStore } from "../src/state/latency-store";
import { useNoticesStore } from "../src/state/notices-store";

beforeEach(() => {
  memory.clear();
  useConnectionStore.setState({ status: { kind: "idle" }, saved: null });
  useLatencyStore.setState({ samples: [], lastSampleAtMs: 0 });
  useNoticesStore.setState({ notices: [] });
});

describe("shortHash", () => {
  it("returns a 12-char hex string", () => {
    expect(shortHash("hello")).toMatch(/^[0-9a-f]{12}$/);
  });
  it("is deterministic", () => {
    expect(shortHash("foo")).toBe(shortHash("foo"));
  });
  it("returns different hashes for different inputs", () => {
    expect(shortHash("foo")).not.toBe(shortHash("bar"));
  });
});

describe("buildDiagnosticReport", () => {
  it("includes the schema version + ISO timestamp", async () => {
    const report = await buildDiagnosticReport();
    expect(report.schemaVersion).toBe(DIAGNOSTIC_SCHEMA_VERSION);
    expect(() => new Date(report.generatedAt).toISOString()).not.toThrow();
  });

  it("buckets idb keys by prefix", async () => {
    memory.set("prefs.theme", "dark");
    memory.set("prefs.pinnedThreadIds", []);
    memory.set("messages:thread-1", []);
    memory.set("messages:thread-2", []);
    memory.set("phoneIdentity", {});
    const report = await buildDiagnosticReport();
    expect(report.storage.totalKeys).toBe(5);
    expect(report.storage.byPrefix["prefs.*"]).toBe(2);
    expect(report.storage.byPrefix["messages:*"]).toBe(2);
    expect(report.storage.byPrefix.other).toBe(1);
  });

  it("hashes thread ids in the persisted-thread sample", async () => {
    memory.set("messages:my-secret-thread", []);
    const report = await buildDiagnosticReport();
    expect(report.storage.persistedThreadIdsHashed).toHaveLength(1);
    expect(report.storage.persistedThreadIdsHashed[0]).toBe(shortHash("my-secret-thread"));
    // Plain thread id must NOT appear anywhere in the report.
    const json = JSON.stringify(report);
    expect(json.includes("my-secret-thread")).toBe(false);
  });

  it("redacts pairing identifiers via shortHash", async () => {
    useConnectionStore.setState({
      status: { kind: "open" },
      saved: {
        relayUrl: "https://relay.example",
        sessionId: "session-abc-123",
        macDeviceId: "mac-xyz-789",
        macIdentityPublicKey: "pubkey-bytes",
        lastAppliedBridgeOutboundSeq: 0,
        shouldForceQrBootstrap: false,
      },
    } as unknown as Partial<ReturnType<typeof useConnectionStore.getState>>);
    const report = await buildDiagnosticReport();
    const json = JSON.stringify(report);
    expect(json.includes("session-abc-123")).toBe(false);
    expect(json.includes("mac-xyz-789")).toBe(false);
    // Public key isn't in the report at all.
    expect(json.includes("pubkey-bytes")).toBe(false);
    // Hashes ARE there.
    expect(report.connection.pairing?.sessionIdHash).toBe(shortHash("session-abc-123"));
    expect(report.connection.pairing?.macDeviceIdHash).toBe(shortHash("mac-xyz-789"));
  });

  it("computes latency stats from the live store", async () => {
    useLatencyStore.setState({ samples: [10, 20, 30, 40, 50], lastSampleAtMs: 12345 });
    const report = await buildDiagnosticReport();
    expect(report.latency.sampleCount).toBe(5);
    expect(report.latency.medianMs).toBe(30);
    expect(report.latency.lastSampleAtMs).toBe(12345);
  });

  it("normalises lastSampleAtMs:0 to null", async () => {
    useLatencyStore.setState({ samples: [], lastSampleAtMs: 0 });
    const report = await buildDiagnosticReport();
    expect(report.latency.lastSampleAtMs).toBeNull();
  });

  it("only carries notice severity + title (no message body)", async () => {
    useNoticesStore.setState({
      notices: [
        { id: "1", severity: "info", title: "Hi", message: "A secret detail you don't want shipped" },
      ],
    });
    const report = await buildDiagnosticReport();
    expect(report.notices[0]).toEqual({ severity: "info", title: "Hi" });
  });
});
