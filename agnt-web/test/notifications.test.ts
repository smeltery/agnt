// Tests run in node where there's no real Notification API. We stub it for
// the construction-and-permission paths and stub idb so prefsStore.load
// returns a controllable preference. The tests focus on the contract:
// shouldNotify gates correctly, showNotification is a no-op when the API
// is missing, requestPermission resolves to the platform's reply.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const memory = new Map<string, unknown>();
vi.mock("../src/storage/idb", () => ({
  idb: {
    async get<T>(key: string): Promise<T | undefined> {
      return memory.get(key) as T | undefined;
    },
    async set<T>(key: string, value: T): Promise<void> {
      memory.set(key, value);
    },
    async remove(key: string): Promise<void> {
      memory.delete(key);
    },
  },
}));

import {
  permissionLabel,
  requestPermission,
  shouldNotify,
  showNotification,
} from "../src/lib/notifications";
import { prefsStore } from "../src/storage/prefs-store";

interface FakeNotificationCtor {
  permission: NotificationPermission;
  requestPermission?: (() => Promise<NotificationPermission>) | undefined;
  /** Track every constructed notification so the test can introspect. */
  instances: Array<{ title: string; options?: NotificationOptions; closed: boolean }>;
}

function installFakeNotification(initialPermission: NotificationPermission): FakeNotificationCtor {
  const instances: FakeNotificationCtor["instances"] = [];
  function Stub(this: { title: string; options?: NotificationOptions; closed: boolean; close(): void; onclick: (() => void) | null }, title: string, options?: NotificationOptions) {
    this.title = title;
    this.options = options;
    this.closed = false;
    this.close = () => {
      this.closed = true;
    };
    this.onclick = null;
    instances.push({ title, options, closed: false });
  }
  const ctor = Stub as unknown as FakeNotificationCtor & { new (title: string, options?: NotificationOptions): unknown };
  ctor.permission = initialPermission;
  ctor.requestPermission = vi.fn(async () => initialPermission) as unknown as () => Promise<NotificationPermission>;
  ctor.instances = instances;
  Object.defineProperty(globalThis, "Notification", { value: ctor, configurable: true });
  return ctor;
}

const originalNotification = (globalThis as { Notification?: unknown }).Notification;
const originalDocument = globalThis.document;

beforeEach(() => {
  memory.clear();
});

afterEach(() => {
  if (originalNotification === undefined) {
    delete (globalThis as { Notification?: unknown }).Notification;
  } else {
    Object.defineProperty(globalThis, "Notification", { value: originalNotification, configurable: true });
  }
  Object.defineProperty(globalThis, "document", { value: originalDocument, configurable: true });
  vi.restoreAllMocks();
});

describe("permissionLabel", () => {
  it("reports unsupported when Notification is missing", () => {
    delete (globalThis as { Notification?: unknown }).Notification;
    expect(permissionLabel()).toBe("unsupported");
  });

  it("forwards the platform value when present", () => {
    installFakeNotification("denied");
    expect(permissionLabel()).toBe("denied");
  });
});

describe("requestPermission", () => {
  it("returns unsupported when the API is missing", async () => {
    delete (globalThis as { Notification?: unknown }).Notification;
    expect(await requestPermission()).toBe("unsupported");
  });

  it("short-circuits when the platform already decided", async () => {
    const fake = installFakeNotification("granted");
    expect(await requestPermission()).toBe("granted");
    expect(fake.requestPermission).not.toHaveBeenCalled();
  });

  it("asks the platform when the prior answer was default", async () => {
    const fake = installFakeNotification("default");
    fake.requestPermission = vi.fn(async () => "granted") as unknown as () => Promise<NotificationPermission>;
    expect(await requestPermission()).toBe("granted");
    expect(fake.requestPermission).toHaveBeenCalled();
  });
});

describe("shouldNotify", () => {
  it("returns false when permission isn't granted", async () => {
    installFakeNotification("denied");
    Object.defineProperty(globalThis, "document", { value: { hidden: true }, configurable: true });
    expect(await shouldNotify()).toBe(false);
  });

  it("returns false when the tab is focused — inline UI is enough", async () => {
    installFakeNotification("granted");
    Object.defineProperty(globalThis, "document", { value: { hidden: false }, configurable: true });
    expect(await shouldNotify()).toBe(false);
  });

  it("returns false when the user explicitly turned notifications off", async () => {
    installFakeNotification("granted");
    Object.defineProperty(globalThis, "document", { value: { hidden: true }, configurable: true });
    await prefsStore.saveNotifications("off");
    expect(await shouldNotify()).toBe(false);
  });

  it("returns true when permission is granted, tab is hidden, and pref isn't off", async () => {
    installFakeNotification("granted");
    Object.defineProperty(globalThis, "document", { value: { hidden: true }, configurable: true });
    await prefsStore.saveNotifications("on");
    expect(await shouldNotify()).toBe(true);
  });
});

describe("showNotification", () => {
  it("constructs a Notification with the agnt: tag prefix when granted", () => {
    const fake = installFakeNotification("granted");
    showNotification({ title: "Done", body: "x", tag: "thread-1" });
    expect(fake.instances).toHaveLength(1);
    expect(fake.instances[0].options?.tag).toBe("agnt:thread-1");
  });

  it("does nothing when the API is missing", () => {
    delete (globalThis as { Notification?: unknown }).Notification;
    expect(() => showNotification({ title: "Done" })).not.toThrow();
  });

  it("does nothing when permission isn't granted", () => {
    const fake = installFakeNotification("denied");
    showNotification({ title: "Done" });
    expect(fake.instances).toHaveLength(0);
  });
});
