// Pairing-code HTTP resolver. The bridge prints both a JSON pairing payload
// and a short alphanumeric code (e.g. "AB12-CDEF34"); the relay swaps that
// short code for the same payload via POST /v1/pairing/code/resolve.
// Mirrors CodexService+SecureTransport.swift:resolvePairingCode.

import type { PairingPayload } from "./pairing";

export interface ResolvePairingCodeInput {
  /**
   * Relay base URL. Accepts ws://, wss://, http://, or https:// with or without
   * a trailing /relay segment, the same way the iOS resolver does.
   */
  relayUrl: string;
  code: string;
}

export class PairingCodeResolveError extends Error {
  constructor(message: string, public code: string) {
    super(message);
    this.name = "PairingCodeResolveError";
  }
}

export async function resolvePairingCode(input: ResolvePairingCodeInput): Promise<PairingPayload> {
  const normalizedCode = normalizeShortCode(input.code);
  if (!normalizedCode) throw new PairingCodeResolveError("Enter a valid pairing code.", "invalid_request");
  const candidates = candidateResolveUrls(toHttpBase(input.relayUrl));
  if (candidates.length === 0) {
    throw new PairingCodeResolveError("No relay URL available — paste the QR JSON instead.", "no_relay");
  }
  const body = JSON.stringify({ code: normalizedCode });

  let lastError: PairingCodeResolveError | null = null;
  for (const url of candidates) {
    try {
      return await postResolve(url, body);
    } catch (error) {
      const remote = error as PairingCodeResolveError;
      if (!shouldTryNext(remote.code)) throw remote;
      lastError = remote;
    }
  }
  throw lastError ?? new PairingCodeResolveError("This relay does not support pairing codes.", "unsupported_relay");
}

async function postResolve(url: string, body: string): Promise<PairingPayload> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  if (response.ok) {
    const json = (await response.json()) as PairingPayload & { ok?: boolean };
    if (json.ok === false) throw new PairingCodeResolveError("Relay returned malformed response.", "invalid_response");
    return json;
  }
  const text = await response.text().catch(() => "");
  let code = "network";
  let message: string | undefined;
  try {
    const parsed = JSON.parse(text) as { code?: string; error?: string };
    code = parsed.code ?? code;
    message = parsed.error;
  } catch {
    // not JSON; fall back to status-based message
  }
  if (response.status === 404) throw new PairingCodeResolveError("Relay does not support pairing codes.", "unsupported_relay");
  if (code === "pairing_code_expired")
    throw new PairingCodeResolveError(
      "This pairing code has expired. Generate a new one from the bridge.",
      code
    );
  if (code === "pairing_code_unavailable")
    throw new PairingCodeResolveError(
      "That pairing code is not available right now. Make sure your bridge is running.",
      code
    );
  throw new PairingCodeResolveError(message ?? `Relay refused (${response.status})`, code);
}

function shouldTryNext(code: string): boolean {
  return code === "unsupported_relay" || code === "invalid_response" || code === "network";
}

function normalizeShortCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[\s-]+/g, "");
}

function toHttpBase(relayUrl: string): string {
  return relayUrl.trim().replace(/^ws(s?):\/\//i, (_, secure) => `http${secure}://`).replace(/\/+$/, "");
}

function candidateResolveUrls(httpBase: string): string[] {
  const candidates = new Set<string>();
  try {
    const parsed = new URL(httpBase);
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments[segments.length - 1] === "relay") {
      const prefix = segments.slice(0, -1).join("/");
      candidates.add(`${parsed.origin}${prefix ? `/${prefix}` : ""}/v1/pairing/code/resolve`);
    }
    candidates.add(`${parsed.origin}/v1/pairing/code/resolve`);
  } catch {
    candidates.add(`${httpBase}/v1/pairing/code/resolve`);
  }
  return Array.from(candidates);
}
