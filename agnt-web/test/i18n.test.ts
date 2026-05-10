// Translator contract: dictionary lookup falls back to English when the
// active locale is missing the key, falls back to the key itself when
// even English is missing, and ICU-lite `{name}` placeholders interpolate.

import { afterEach, describe, expect, it } from "vitest";
import { dictionaries, formatNumber, translate, useI18nStore } from "../src/lib/i18n";

afterEach(() => {
  useI18nStore.setState({ locale: "en" });
});

describe("translate", () => {
  it("returns the key itself when no dictionary entry exists at all", () => {
    expect(translate("en", "totally.unknown.key")).toBe("totally.unknown.key");
  });

  it("looks up the active-locale entry when present", () => {
    dictionaries.es["common.cancel"] = "Cancelar";
    try {
      expect(translate("es", "common.cancel")).toBe("Cancelar");
    } finally {
      delete dictionaries.es["common.cancel"];
    }
  });

  it("falls back to English when the locale is missing the key", () => {
    expect(translate("ja", "common.cancel")).toBe("Cancel");
  });

  it("interpolates ICU-lite placeholders", () => {
    dictionaries.en["test.greet"] = "Hello, {name}!";
    try {
      expect(translate("en", "test.greet", { name: "world" })).toBe("Hello, world!");
    } finally {
      delete dictionaries.en["test.greet"];
    }
  });

  it("leaves unknown placeholders intact instead of swallowing them", () => {
    dictionaries.en["test.partial"] = "{a} and {b}";
    try {
      expect(translate("en", "test.partial", { a: "first" })).toBe("first and {b}");
    } finally {
      delete dictionaries.en["test.partial"];
    }
  });
});

describe("formatNumber", () => {
  it("uses the active locale via Intl.NumberFormat", () => {
    useI18nStore.setState({ locale: "en" });
    expect(formatNumber(1234.5)).toBe("1,234.5");
    useI18nStore.setState({ locale: "de" });
    // Non-breaking-space-or-full-stop separators in de-DE; just check the
    // string includes the comma decimal separator used in German.
    expect(formatNumber(1234.5)).toMatch(/1[.,  ]?234,5/);
  });
});
