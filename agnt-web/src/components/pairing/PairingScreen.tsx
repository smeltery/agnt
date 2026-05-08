// Pairing entrypoint. Three accepted forms:
//   1. Camera scan of the QR (BarcodeDetector path)
//   2. Pasted JSON / RMX1 token (offline path)
//   3. Short pairing code (relay round-trip via /v1/pairing/code/resolve)
//
// The bridge prints all three under one banner; web users pick whichever path
// fits their hardware.

import { useState } from "react";
import {
  PairingCodeResolveError,
  resolvePairingCode,
  validatePairingInput,
} from "../../protocol";
import { useConnectionStore } from "../../state/connection-store";
import { CameraQRScanner } from "./CameraQRScanner";

type Mode = "paste" | "code" | "camera";

export function PairingScreen() {
  const [mode, setMode] = useState<Mode>("paste");
  const [input, setInput] = useState("");
  const [code, setCode] = useState("");
  const [relayUrl, setRelayUrl] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const pairWithPayload = useConnectionStore((state) => state.pairWithPayload);

  async function submitPaste(rawText: string) {
    setErrorMessage(null);
    const result = validatePairingInput(rawText);
    switch (result.kind) {
      case "payload":
        await pairWithPayload(result.payload);
        return;
      case "shortCode":
        // The user pasted a code that fits the short-code shape — switch them
        // to the relay-round-trip mode and pre-fill it.
        setCode(result.code);
        setMode("code");
        setErrorMessage("This looks like a short pairing code — enter the relay URL to complete the lookup.");
        return;
      case "bridgeUpdateRequired":
      case "error":
        setErrorMessage(result.message);
        return;
    }
  }

  async function submitCode(event: React.FormEvent) {
    event.preventDefault();
    setErrorMessage(null);
    if (!relayUrl.trim()) {
      setErrorMessage("Enter the relay URL the bridge prints under the QR (e.g. wss://relay.example.com).");
      return;
    }
    setResolving(true);
    try {
      const payload = await resolvePairingCode({ relayUrl: relayUrl.trim(), code });
      await pairWithPayload(payload);
    } catch (error) {
      if (error instanceof PairingCodeResolveError) setErrorMessage(error.message);
      else setErrorMessage((error as Error).message);
    } finally {
      setResolving(false);
    }
  }

  return (
    <div className="agnt-pairing-screen">
      <header>
        <h1>agnt</h1>
        <p className="agnt-pairing-subtitle">Connect this browser to a Mac running the agnt bridge.</p>
      </header>

      <nav className="agnt-pairing-tabs" role="tablist">
        <PairingTabButton current={mode} value="paste" label="Paste payload" onClick={setMode} />
        <PairingTabButton current={mode} value="code" label="Short code" onClick={setMode} />
        <PairingTabButton current={mode} value="camera" label="Scan QR" onClick={setMode} />
      </nav>

      {mode === "paste" && (
        <form
          className="agnt-pairing-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submitPaste(input);
          }}
        >
          <label className="agnt-pairing-label" htmlFor="pairing-input">Pairing payload</label>
          <textarea
            id="pairing-input"
            className="agnt-pairing-textarea"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder='{"v":2,"relay":"wss://...","sessionId":"...","macDeviceId":"...","macIdentityPublicKey":"...","expiresAt":...}'
            rows={6}
            spellCheck={false}
            autoComplete="off"
          />
          {errorMessage && <div className="agnt-pairing-error">{errorMessage}</div>}
          <button type="submit" className="agnt-button-primary" disabled={!input.trim()}>
            Pair with bridge
          </button>
        </form>
      )}

      {mode === "code" && (
        <form className="agnt-pairing-form" onSubmit={submitCode}>
          <label className="agnt-pairing-label" htmlFor="pairing-relay">Relay URL</label>
          <input
            id="pairing-relay"
            type="url"
            className="agnt-pairing-input"
            value={relayUrl}
            onChange={(event) => setRelayUrl(event.target.value)}
            placeholder="wss://relay.example.com"
            autoComplete="off"
          />
          <label className="agnt-pairing-label" htmlFor="pairing-code">Pairing code</label>
          <input
            id="pairing-code"
            type="text"
            className="agnt-pairing-input agnt-pairing-input-code"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            placeholder="ABCD-EFGH-JKMN"
            autoComplete="off"
            spellCheck={false}
          />
          {errorMessage && <div className="agnt-pairing-error">{errorMessage}</div>}
          <button
            type="submit"
            className="agnt-button-primary"
            disabled={resolving || !code.trim() || !relayUrl.trim()}
          >
            {resolving ? "Resolving…" : "Resolve & pair"}
          </button>
        </form>
      )}

      {mode === "camera" && (
        <CameraQRScanner
          onDetected={(value) => {
            setMode("paste");
            setInput(value);
            void submitPaste(value);
          }}
          onCancel={() => setMode("paste")}
        />
      )}

      <details className="agnt-pairing-help">
        <summary>How do I get this?</summary>
        <ol>
          <li>
            On your Mac, run <code>./scripts/run-local-agnt.sh</code> or <code>npm start</code> in <code>agnt-bridge/</code>.
          </li>
          <li>
            The bridge prints a QR, a <code>{`{"v":2,...}`}</code> JSON line, an <code>RMX1:</code> token, and a short
            alphanumeric code under the QR. Use any one.
          </li>
          <li>Use your camera, paste the JSON, or type the short code with the relay URL.</li>
        </ol>
        <p className="agnt-pairing-hint">
          The bridge and this browser tab need to reach the same agnt relay. If you self-host one, set <code>AGNT_RELAY</code>
          on the bridge and serve agnt-web from any HTTPS origin (Tailscale, Cloudflare Tunnel, your own VPS, …).
        </p>
      </details>
    </div>
  );
}

function PairingTabButton({
  current,
  value,
  label,
  onClick,
}: {
  current: Mode;
  value: Mode;
  label: string;
  onClick: (next: Mode) => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={current === value}
      className={"agnt-pairing-tab" + (current === value ? " agnt-pairing-tab-active" : "")}
      onClick={() => onClick(value)}
    >
      {label}
    </button>
  );
}
