import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";

export function useTauriReady() {
  const [tauriReady, setTauriReady] = useState(false);

  useEffect(() => {
    if (!isTauri()) return;
    const checkReady = () => {
      if ((window as unknown as Record<string, unknown>).__TAURI_INTERNALS__) {
        setTauriReady(true);
      } else {
        setTimeout(checkReady, 50);
      }
    };
    checkReady();
  }, []);

  return tauriReady;
}
