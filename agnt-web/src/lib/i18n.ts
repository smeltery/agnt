// Minimal i18n scaffolding. Strings live in `dictionaries[locale]`; the
// active locale is set from the browser's `navigator.language`, optionally
// overridden by the user via Settings (persisted under `prefs.locale`).
//
// We deliberately avoid pulling in a full i18n library (intl-messageformat,
// react-i18next, etc.) — the surface is small enough that a 50-line
// dictionary lookup with `Intl.MessageFormat`-style ICU placeholders does
// the job. Date / time / number formatting goes through the native `Intl.*`
// constructors so locales we don't translate still get correct
// thousands-separators, AM/PM, etc.
//
// Migration plan: this session ships the scaffolding plus a handful of
// representative migrations as a demo. Future sessions migrate strings
// component-by-component as they're touched.

import { create } from "zustand";

export type LocaleId = "en" | "es" | "fr" | "de" | "ja";

export const SUPPORTED_LOCALES: Array<{ id: LocaleId; label: string }> = [
  { id: "en", label: "English" },
  // The dictionaries below are placeholders so the scaffolding is wired
  // end-to-end. Real translations land in follow-up sessions / via
  // contributors.
  { id: "es", label: "Español (placeholder)" },
  { id: "fr", label: "Français (placeholder)" },
  { id: "de", label: "Deutsch (placeholder)" },
  { id: "ja", label: "日本語 (placeholder)" },
];

/** All translatable strings live here. New keys go in `en` first; other
 *  locales fall back to `en` when a key is missing so the UI never shows
 *  a raw token. */
export const dictionaries: Record<LocaleId, Record<string, string>> = {
  en: {
    "common.cancel": "Cancel",
    "common.save": "Save",
    "common.close": "Close",
    "common.reload": "Reload",
    "common.tryAgain": "Try again",
    "sidebar.newChat": "New",
    "sidebar.search": "Search threads…",
    "sidebar.empty.live": "No live threads yet",
    "sidebar.empty.archived": "No archived threads",
    "sidebar.empty.search": "No threads match",
    "settings.title": "Settings",
    "settings.section.appearance": "Appearance",
    "settings.section.notifications": "Notifications",
    "settings.section.connection": "Connection",
    "settings.section.account": "Account",
    "settings.section.locale": "Language",
    "settings.locale.hint": "Pick the language for the agnt-web UI. Translations are early-stage; missing strings fall back to English.",
  },
  es: {},
  fr: {},
  de: {},
  ja: {},
};

interface I18nState {
  locale: LocaleId;
  /** Set by the consumer (App init) once the locale pref is loaded. */
  setLocale(locale: LocaleId): void;
}

function detectInitialLocale(): LocaleId {
  if (typeof navigator === "undefined" || !navigator.language) return "en";
  const tag = navigator.language.toLowerCase().split(/[-_]/)[0];
  return (SUPPORTED_LOCALES.find((option) => option.id === tag)?.id) ?? "en";
}

export const useI18nStore = create<I18nState>((set) => ({
  locale: detectInitialLocale(),
  setLocale(locale) {
    set({ locale });
  },
}));

/** Pure translator. Looks up the key in the active locale, falling back to
 *  English, falling back to the key itself. ICU-lite `{name}` placeholders
 *  are replaced from the `params` object. */
export function translate(locale: LocaleId, key: string, params?: Record<string, string | number>): string {
  const value = dictionaries[locale]?.[key] ?? dictionaries.en[key] ?? key;
  if (!params) return value;
  return value.replace(/\{(\w+)\}/g, (_match, token) => {
    const replacement = params[token];
    return replacement === undefined ? `{${token}}` : String(replacement);
  });
}

/** React hook returning a memoized `t(key, params)` bound to the active
 *  locale. UI code uses this so re-renders pick up locale switches. */
export function useTranslator(): (key: string, params?: Record<string, string | number>) => string {
  const locale = useI18nStore((state) => state.locale);
  return (key, params) => translate(locale, key, params);
}

/** Format an absolute timestamp via `Intl.DateTimeFormat`. Defaults to a
 *  short, locale-aware "5/9/26, 3:14 PM"-style string. */
export function formatDateTime(timestamp: number, options: Intl.DateTimeFormatOptions = { dateStyle: "short", timeStyle: "short" }): string {
  const locale = useI18nStore.getState().locale;
  return new Intl.DateTimeFormat(locale, options).format(new Date(timestamp));
}

export function formatNumber(value: number, options: Intl.NumberFormatOptions = {}): string {
  const locale = useI18nStore.getState().locale;
  return new Intl.NumberFormat(locale, options).format(value);
}
