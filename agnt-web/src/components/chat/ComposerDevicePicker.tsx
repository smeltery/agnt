import { useEffect, useRef, useState } from "react";
import { formatRelativeTime } from "../../lib/relative-time";
import { useConnectionStore } from "../../state/connection-store";
import { pairingStore, type TrustedMacRecord, type TrustedMacRegistry } from "../../storage/pairing-store";
import { ChevronDown, Cloud } from "../shared/Icon";

export function ComposerDevicePicker() {
  const saved = useConnectionStore((state) => state.saved);
  const switching = useConnectionStore((state) => state.switching);
  const switchMac = useConnectionStore((state) => state.switchMac);
  const [registry, setRegistry] = useState<TrustedMacRegistry | null>(null);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    void pairingStore.loadRegistry().then((next) => {
      if (!cancelled) setRegistry(next);
    });
    return () => {
      cancelled = true;
    };
  }, [saved?.macDeviceId]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!saved || !registry) return null;

  const records = Object.values(registry.records);
  if (records.length < 2) return null;

  const currentRecord =
    registry.records[saved.macDeviceId] ??
    ({ macDeviceId: saved.macDeviceId } as Partial<TrustedMacRecord>);
  const currentLabel = currentRecord.displayName ?? shortDeviceId(saved.macDeviceId);
  const orderedRecords = records
    .slice()
    .sort((a, b) => {
      if (a.macDeviceId === saved.macDeviceId) return -1;
      if (b.macDeviceId === saved.macDeviceId) return 1;
      return (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0);
    });

  function chooseDevice(macDeviceId: string) {
    setOpen(false);
    if (macDeviceId === saved?.macDeviceId) return;
    void switchMac(macDeviceId);
  }

  return (
    <div className="agnt-composer-device-picker" ref={rootRef}>
      <button
        type="button"
        className="agnt-composer-meta-button"
        onClick={() => setOpen((value) => !value)}
        disabled={switching}
        aria-haspopup="menu"
        aria-expanded={open}
        title={switching ? "Switching device..." : "Run on"}
      >
        <span className="agnt-composer-meta-kicker">Run on</span>
        <Cloud size={14} />
        <span className="agnt-composer-meta-value">{switching ? "Switching..." : currentLabel}</span>
        <ChevronDown size={13} />
      </button>
      {open && (
        <div className="agnt-composer-device-menu" role="menu" aria-label="Run on device">
          <div className="agnt-composer-device-menu-title">Run on</div>
          {orderedRecords.map((record) => {
            const isCurrent = record.macDeviceId === saved.macDeviceId;
            const label = record.displayName ?? shortDeviceId(record.macDeviceId);
            return (
              <button
                key={record.macDeviceId}
                type="button"
                role="menuitemradio"
                aria-checked={isCurrent}
                className={
                  "agnt-composer-device-option"
                  + (isCurrent ? " agnt-composer-device-option-current" : "")
                }
                onClick={() => chooseDevice(record.macDeviceId)}
                disabled={switching}
              >
                <Cloud size={15} />
                <span className="agnt-composer-device-option-main">
                  <span className="agnt-composer-device-option-name">{label}</span>
                  <span className="agnt-composer-device-option-detail">{formatRelativeTime(record.lastUsedAt)}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function shortDeviceId(macDeviceId: string): string {
  if (macDeviceId.length <= 12) return macDeviceId;
  return `${macDeviceId.slice(0, 6)}...${macDeviceId.slice(-4)}`;
}
