// Sidebar row that surfaces the active trusted Mac and lets the user switch
// between previously-paired Macs. Mirrors the iOS MyMacsView affordance.
// Hidden when only one (or zero) Mac is paired — pointless chrome otherwise.

import { useEffect, useRef, useState } from "react";
import { useConnectionStore } from "../../state/connection-store";
import { pairingStore, TrustedMacRecord, TrustedMacRegistry } from "../../storage/pairing-store";
import { formatRelativeTime } from "../../lib/relative-time";
import { ChevronDown } from "../shared/Icon";

export function MacSwitcher() {
  const saved = useConnectionStore((s) => s.saved);
  const switching = useConnectionStore((s) => s.switching);
  const switchMac = useConnectionStore((s) => s.switchMac);

  const [registry, setRegistry] = useState<TrustedMacRegistry | null>(null);
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement | null>(null);

  // Refresh the registry whenever the active pairing changes (covers pair / forget / switch).
  useEffect(() => {
    let cancelled = false;
    void pairingStore.loadRegistry().then((r) => {
      if (!cancelled) setRegistry(r);
    });
    return () => {
      cancelled = true;
    };
  }, [saved?.macDeviceId]);

  // Close on outside-click / Escape.
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!registry || !saved) return null;
  const records = Object.values(registry.records);
  // Single-Mac users get no switcher chrome.
  if (records.length < 2) return null;

  const currentRecord =
    registry.records[saved.macDeviceId] ??
    ({ macDeviceId: saved.macDeviceId, displayName: undefined } as Partial<TrustedMacRecord>);
  const currentLabel = currentRecord.displayName ?? shortMacId(saved.macDeviceId);

  // Most-recently-used first; the active Mac is always pinned on top.
  const others = records
    .filter((r) => r.macDeviceId !== saved.macDeviceId)
    .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0));

  function pickMac(macDeviceId: string) {
    setOpen(false);
    void switchMac(macDeviceId);
  }

  return (
    <div className="agnt-mac-switcher" ref={dropdownRef}>
      <button
        type="button"
        className="agnt-mac-switcher-button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="listbox"
        disabled={switching}
        title={switching ? "Switching Macs…" : "Switch Mac"}
      >
        <span className="agnt-mac-switcher-dot" aria-hidden />
        <span className="agnt-mac-switcher-label">
          {switching ? "Switching…" : currentLabel}
        </span>
        <ChevronDown />
      </button>
      {open && (
        <ul className="agnt-mac-switcher-menu" role="listbox">
          <li className="agnt-mac-switcher-item agnt-mac-switcher-item-current" aria-selected="true">
            <span className="agnt-mac-switcher-item-name">{currentLabel}</span>
            <span className="agnt-mac-switcher-item-current-tag">current</span>
          </li>
          {others.map((mac) => (
            <li key={mac.macDeviceId} role="option">
              <button
                type="button"
                className="agnt-mac-switcher-item"
                onClick={() => pickMac(mac.macDeviceId)}
                disabled={switching}
              >
                <span className="agnt-mac-switcher-item-name">
                  {mac.displayName ?? shortMacId(mac.macDeviceId)}
                </span>
                <span className="agnt-mac-switcher-item-sub">{formatRelativeTime(mac.lastUsedAt)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function shortMacId(macDeviceId: string): string {
  if (macDeviceId.length <= 12) return macDeviceId;
  return `${macDeviceId.slice(0, 6)}…${macDeviceId.slice(-4)}`;
}
