import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "../src/lib/clipboard";

const realNavigator = globalThis.navigator;
const realDocument = globalThis.document;

afterEach(() => {
  Object.defineProperty(globalThis, "navigator", { value: realNavigator, configurable: true });
  Object.defineProperty(globalThis, "document", { value: realDocument, configurable: true });
});

describe("copyText", () => {
  it("returns false for empty input without touching the clipboard API", async () => {
    const writeText = vi.fn();
    Object.defineProperty(globalThis, "navigator", {
      value: { clipboard: { writeText } },
      configurable: true,
    });
    expect(await copyText("")).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("uses navigator.clipboard.writeText when available", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(globalThis, "navigator", {
      value: { clipboard: { writeText } },
      configurable: true,
    });
    expect(await copyText("hello")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("falls back to legacyCopy when clipboard.writeText throws (denied permission / non-secure context)", async () => {
    const writeText = vi.fn(async () => {
      throw new Error("denied");
    });
    Object.defineProperty(globalThis, "navigator", {
      value: { clipboard: { writeText } },
      configurable: true,
    });
    Object.defineProperty(globalThis, "document", { value: undefined, configurable: true });
    expect(await copyText("hello")).toBe(false);
    expect(writeText).toHaveBeenCalled();
  });

  it("returns false when neither path is available (Node test runner)", async () => {
    Object.defineProperty(globalThis, "navigator", { value: {}, configurable: true });
    Object.defineProperty(globalThis, "document", { value: undefined, configurable: true });
    expect(await copyText("hi")).toBe(false);
  });
});
