// Trusted-session HTTP resolver — used after the bridge restarts to discover the new
// relay sessionId without forcing a fresh QR scan. Mirrors the flow in
// CodexService+SecureTransport.swift's resolveTrustedMacSessionImpl.

import { buildTrustedSessionResolveTranscript, signWithPhoneIdentity, type PhoneIdentity } from "../crypto";

export interface TrustedSessionResolveInput {
  relayUrl: string;
  macDeviceId: string;
  phoneIdentity: PhoneIdentity;
}

export interface TrustedSessionResolveResponse {
  ok: true;
  macDeviceId: string;
  macIdentityPublicKey: string;
  sessionId: string;
  displayName?: string | null;
}

export class TrustedSessionResolveError extends Error {
  constructor(message: string, public code: string) {
    super(message);
    this.name = "TrustedSessionResolveError";
  }
}

export async function resolveTrustedSession(input: TrustedSessionResolveInput): Promise<TrustedSessionResolveResponse> {
  const httpBase = toHttpBase(input.relayUrl);
  const candidates = candidateResolveUrls(httpBase);
  const nonce = crypto.randomUUID();
  const timestamp = Date.now();

  const transcript = buildTrustedSessionResolveTranscript({
    macDeviceId: input.macDeviceId,
    phoneDeviceId: input.phoneIdentity.phoneDeviceId,
    phoneIdentityPublicKey: input.phoneIdentity.phoneIdentityPublicKey,
    nonce,
    timestamp,
  });
  const signature = signWithPhoneIdentity(input.phoneIdentity, transcript);
  const body = JSON.stringify({
    macDeviceId: input.macDeviceId,
    phoneDeviceId: input.phoneIdentity.phoneDeviceId,
    phoneIdentityPublicKey: input.phoneIdentity.phoneIdentityPublicKey,
    nonce,
    timestamp,
    signature,
  });

  let lastError: TrustedSessionResolveError | null = null;
  for (const url of candidates) {
    try {
      return await postResolve(url, body);
    } catch (error) {
      const remote = error as TrustedSessionResolveError;
      if (!shouldTryNext(remote.code)) throw remote;
      lastError = remote;
    }
  }
  throw lastError ?? new TrustedSessionResolveError("relay does not support trusted reconnect", "unsupported_relay");
}

async function postResolve(url: string, body: string): Promise<TrustedSessionResolveResponse> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  if (response.ok) {
    const json = (await response.json()) as TrustedSessionResolveResponse;
    if (!json.ok) throw new TrustedSessionResolveError("relay returned malformed response", "invalid_response");
    return json;
  }
  const text = await response.text().catch(() => "");
  let code = "network";
  try {
    code = (JSON.parse(text) as { code?: string }).code ?? code;
  } catch {
    // text wasn't JSON; keep default
  }
  if (response.status === 404) throw new TrustedSessionResolveError("relay does not support trusted reconnect", "unsupported_relay");
  throw new TrustedSessionResolveError(`relay refused (${response.status})`, code);
}

function shouldTryNext(code: string): boolean {
  return code === "unsupported_relay" || code === "invalid_response" || code === "network";
}

function toHttpBase(relayUrl: string): string {
  return relayUrl.trim().replace(/^ws(s?):\/\//i, (_, secure) => `http${secure}://`).replace(/\/+$/, "");
}

// Mirrors CodexTrustedSessionResolveURLBuilder.candidates: try a /relay-prefixed path
// (for relays mounted under /relay) and fall back to the root /v1 path.
function candidateResolveUrls(httpBase: string): string[] {
  const candidates = new Set<string>();
  try {
    const parsed = new URL(httpBase);
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments[segments.length - 1] === "relay") {
      const prefix = segments.slice(0, -1).join("/");
      candidates.add(`${parsed.origin}${prefix ? `/${prefix}` : ""}/v1/trusted/session/resolve`);
    }
    candidates.add(`${parsed.origin}/v1/trusted/session/resolve`);
  } catch {
    candidates.add(`${httpBase}/v1/trusted/session/resolve`);
  }
  return Array.from(candidates);
}
