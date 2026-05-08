import { afterEach, describe, expect, it } from "vitest";
import { applyThemeToDocument } from "../src/storage/prefs-store";

const originalDocument = globalThis.document;

afterEach(() => {
  Object.defineProperty(globalThis, "document", { value: originalDocument, configurable: true });
});

describe("applyThemeToDocument", () => {
  function fakeDoc() {
    const dataset: Record<string, string> = {};
    const root = {
      dataset,
      removeAttribute(name: string) {
        if (name === "data-theme") delete dataset.theme;
      },
    };
    return { documentElement: root, dataset };
  }

  it("explicit dark / light writes data-theme on the documentElement", () => {
    const doc = fakeDoc();
    Object.defineProperty(globalThis, "document", { value: doc, configurable: true });
    applyThemeToDocument("dark");
    expect(doc.dataset.theme).toBe("dark");
    applyThemeToDocument("light");
    expect(doc.dataset.theme).toBe("light");
  });

  it("auto removes the attribute so the @media block governs", () => {
    const doc = fakeDoc();
    Object.defineProperty(globalThis, "document", { value: doc, configurable: true });
    applyThemeToDocument("dark");
    expect(doc.dataset.theme).toBe("dark");
    applyThemeToDocument("auto");
    expect(doc.dataset.theme).toBeUndefined();
  });

  it("no-ops in non-DOM environments (e.g. node tests at module load)", () => {
    Object.defineProperty(globalThis, "document", { value: undefined, configurable: true });
    expect(() => applyThemeToDocument("dark")).not.toThrow();
  });
});
