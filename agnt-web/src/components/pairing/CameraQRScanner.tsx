// Live camera QR scanner. Uses the native `BarcodeDetector` API on Chromium
// and Safari ≥ 17 — no JS QR-decoding library, so the bundle stays lean.
// On unsupported browsers we surface a clear "manual entry only" message
// instead of pretending the camera button works.

import { useEffect, useRef, useState } from "react";

interface CameraQRScannerProps {
  onDetected(value: string): void;
  onCancel(): void;
}

interface BarcodeDetectorLike {
  detect(source: HTMLVideoElement): Promise<Array<{ rawValue: string }>>;
}

declare global {
  interface Window {
    BarcodeDetector?: { new (options?: { formats?: string[] }): BarcodeDetectorLike };
  }
}

export function CameraQRScanner({ onDetected, onCancel }: CameraQRScannerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string>("Hold the bridge's QR code in view…");
  const supported = typeof window !== "undefined" && typeof window.BarcodeDetector === "function";

  useEffect(() => {
    if (!supported) {
      setError("This browser doesn't support camera QR scanning. Paste the JSON or pairing code instead.");
      return;
    }

    let cancelled = false;
    let stream: MediaStream | null = null;
    let frameHandle = 0;

    const detector = new window.BarcodeDetector!({ formats: ["qr_code"] });

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      } catch {
        setError("Couldn't access the camera. Grant permission or paste the code instead.");
        return;
      }
      if (cancelled) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      await video.play().catch(() => undefined);
      tick();
    })();

    async function tick() {
      const video = videoRef.current;
      if (cancelled || !video || video.readyState < 2) {
        frameHandle = window.requestAnimationFrame(tick);
        return;
      }
      try {
        const results = await detector.detect(video);
        const hit = results.find((r) => typeof r.rawValue === "string" && r.rawValue.trim());
        if (hit) {
          setHint("Got it.");
          onDetected(hit.rawValue);
          return;
        }
      } catch {
        // detect() can throw on transient track issues — keep polling.
      }
      frameHandle = window.requestAnimationFrame(tick);
    }

    return () => {
      cancelled = true;
      if (frameHandle) window.cancelAnimationFrame(frameHandle);
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [supported, onDetected]);

  return (
    <div className="agnt-qr-scanner">
      <div className="agnt-qr-scanner-frame">
        <video ref={videoRef} className="agnt-qr-scanner-video" muted playsInline />
        <div className="agnt-qr-scanner-reticule" aria-hidden />
      </div>
      <div className="agnt-qr-scanner-status">{error ?? hint}</div>
      <button type="button" className="agnt-button-ghost" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}
