// Pairing screen. Web users can't scan a camera QR (yet — Session 5 in ROADMAP), so
// they paste the JSON payload that the bridge prints alongside the QR.
// `agnt up` prints both the QR and the raw payload string, so the copy is visible
// to anyone running the bridge in their terminal.

import { useState } from "react";
import { validatePairingInput } from "../../protocol";
import { useConnectionStore } from "../../state/connection-store";

export function PairingScreen() {
  const [input, setInput] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const pairWithPayload = useConnectionStore((state) => state.pairWithPayload);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setErrorMessage(null);
    const result = validatePairingInput(input);
    switch (result.kind) {
      case "payload":
        await pairWithPayload(result.payload);
        return;
      case "shortCode":
        setErrorMessage("Short pairing codes need a relay round-trip — paste the JSON payload for now.");
        return;
      case "bridgeUpdateRequired":
      case "error":
        setErrorMessage(result.message);
        return;
    }
  }

  return (
    <div className="agnt-pairing-screen">
      <header>
        <h1>agnt</h1>
        <p className="agnt-pairing-subtitle">Paste the pairing payload printed under the QR by your bridge.</p>
      </header>

      <form className="agnt-pairing-form" onSubmit={handleSubmit}>
        <label className="agnt-pairing-label" htmlFor="pairing-input">
          Pairing payload
        </label>
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

      <details className="agnt-pairing-help">
        <summary>How do I get this payload?</summary>
        <ol>
          <li>
            On your Mac, run <code>./scripts/run-local-agnt.sh</code> or <code>npm start</code> in <code>agnt-bridge/</code>.
          </li>
          <li>
            Copy the <code>{`{"v":2,...}`}</code> JSON line printed under the QR (or the <code>RMX1:</code> token).
          </li>
          <li>Paste it here and tap Pair.</li>
        </ol>
        <p className="agnt-pairing-hint">
          The bridge and this browser tab need to reach the same agnt relay. If you self-host one, set <code>AGNT_RELAY</code>
          on the bridge and serve agnt-web from any HTTPS origin (Tailscale, Cloudflare Tunnel, your own VPS, …).
        </p>
      </details>
    </div>
  );
}
