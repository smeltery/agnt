import { useEffect, useState } from "react";
import { playTurnCue } from "../../lib/sound-cue";
import { useContrastStore } from "../../state/contrast-store";
import { type LocaleId, SUPPORTED_LOCALES, useI18nStore, useTranslator } from "../../lib/i18n";
import { useInstallPromptStore } from "../../state/install-prompt-store";
import { prefsStore, type NotificationsPreference, type ThemePreference } from "../../storage/prefs-store";
import { permissionLabel, requestPermission } from "../../lib/notifications";

interface AppearanceSectionProps {
  theme: ThemePreference;
  setTheme(theme: ThemePreference): void | Promise<void>;
}

export function LocaleSection() {
  const t = useTranslator();
  const locale = useI18nStore((state) => state.locale);
  const setLocale = useI18nStore((state) => state.setLocale);
  async function pick(next: LocaleId) {
    setLocale(next);
    await prefsStore.saveLocale(next);
  }
  return (
    <section className="agnt-settings-section">
      <h3>{t("settings.section.locale")}</h3>
      <p className="agnt-settings-hint">{t("settings.locale.hint")}</p>
      <div className="agnt-settings-row">
        <label className="agnt-settings-row-label" htmlFor="agnt-locale-select">Locale</label>
        <select
          id="agnt-locale-select"
          className="agnt-settings-input"
          value={locale}
          onChange={(event) => void pick(event.target.value as LocaleId)}
        >
          {SUPPORTED_LOCALES.map((option) => (
            <option key={option.id} value={option.id}>{option.label}</option>
          ))}
        </select>
      </div>
    </section>
  );
}

export function AppearanceSection({ theme, setTheme }: AppearanceSectionProps) {
  const t = useTranslator();
  return (
    <section className="agnt-settings-section">
      <h3>{t("settings.section.appearance")}</h3>
      <div className="agnt-settings-row">
        <span>Theme</span>
        <div className="agnt-settings-segments" role="radiogroup" aria-label="Theme">
          {(["auto", "light", "dark"] as ThemePreference[]).map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={theme === value}
              className={"agnt-settings-segment" + (theme === value ? " agnt-settings-segment-active" : "")}
              onClick={() => void setTheme(value)}
            >
              {value === "auto" ? "Auto" : value === "light" ? "Light" : "Dark"}
            </button>
          ))}
        </div>
      </div>
      <HighContrastRow />
    </section>
  );
}

export function NotificationsSection() {
  const t = useTranslator();
  const [notificationsPref, setNotificationsPref] = useState<NotificationsPreference>("auto");
  const [permission, setPermission] = useState(permissionLabel());
  useEffect(() => {
    void prefsStore.loadNotifications().then(setNotificationsPref);
  }, []);
  async function pickNotifications(next: NotificationsPreference) {
    setNotificationsPref(next);
    await prefsStore.saveNotifications(next);
    if (next === "on" && permission === "default") {
      const result = await requestPermission();
      setPermission(result);
    }
  }

  return (
    <section className="agnt-settings-section">
      <h3>{t("settings.section.notifications")}</h3>
      <div className="agnt-settings-row">
        <span>Desktop alerts on turn completion</span>
        <div className="agnt-settings-segments" role="radiogroup" aria-label="Desktop notifications">
          {(["auto", "on", "off"] as NotificationsPreference[]).map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={notificationsPref === value}
              className={"agnt-settings-segment" + (notificationsPref === value ? " agnt-settings-segment-active" : "")}
              onClick={() => void pickNotifications(value)}
            >
              {value === "auto" ? "Auto" : value === "on" ? "On" : "Off"}
            </button>
          ))}
        </div>
      </div>
      <p className="agnt-settings-hint">
        {permission === "unsupported"
          ? "This browser doesn't support desktop notifications. The tab title will still flash."
          : permission === "denied"
            ? "You blocked notifications for this site in your browser. Re-enable them in site settings to allow desktop alerts."
            : permission === "granted"
              ? "Permission granted. Notifications fire only while the agnt tab is hidden so you don't get duplicate signals."
              : "Pick On to grant notification permission. Auto stays quiet until you opt in."}
      </p>
      <SoundCueRow />
    </section>
  );
}

export function InstallSection() {
  const state = useInstallPromptStore((s) => s.state);
  const promptInstall = useInstallPromptStore((s) => s.promptInstall);
  if (state === "unsupported") return null;
  return (
    <section className="agnt-settings-section">
      <h3>Install</h3>
      <p className="agnt-settings-hint">
        Install agnt as a standalone app on this device. The browser tab gets its own dock / launcher icon and runs without
        the browser chrome — useful for keeping a long-running thread visible while you work.
      </p>
      {state === "installed" ? (
        <p className="agnt-settings-hint">Already installed on this device.</p>
      ) : (
        <button
          type="button"
          className="agnt-button-primary"
          onClick={() => void promptInstall()}
          disabled={state === "installing"}
        >
          {state === "installing" ? "Waiting for confirmation…" : "Install agnt"}
        </button>
      )}
    </section>
  );
}

function HighContrastRow() {
  const enabled = useContrastStore((state) => state.enabled);
  const systemPrefers = useContrastStore((state) => state.systemPrefers);
  const setEnabled = useContrastStore((state) => state.setEnabled);
  return (
    <div className="agnt-settings-row">
      <span>High contrast</span>
      <label className="agnt-settings-row-checkbox">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => void setEnabled(event.target.checked)}
          aria-label="Enable high-contrast variant"
        />
        <span className="agnt-settings-row-hint">
          {enabled
            ? "On — bumped border weights + text contrast"
            : systemPrefers
              ? "Following system preference (currently on)"
              : "Off — defer to default theme contrast"}
        </span>
      </label>
    </div>
  );
}

function SoundCueRow() {
  const [volume, setVolume] = useState<number>(0);
  useEffect(() => {
    void prefsStore.loadSoundVolume().then(setVolume);
  }, []);
  async function commit(next: number) {
    setVolume(next);
    await prefsStore.saveSoundVolume(next);
    if (next > 0) void playTurnCue("completed", { volume: next });
  }
  return (
    <div className="agnt-settings-row">
      <span>Sound cue on turn complete</span>
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={volume}
        onChange={(event) => void commit(Number(event.target.value))}
        aria-label="Sound cue volume"
        title="Drag to set volume; 0 = silent"
      />
      <span className="agnt-settings-row-hint">{volume === 0 ? "Silent" : `${Math.round(volume * 100)}%`}</span>
    </div>
  );
}
