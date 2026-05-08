// JSON-RPC 2.0 client. Each outbound payload is handed to SecureChannel which seals
// and frames it; inbound payloads come back as already-decrypted strings.
//
// We keep this layer free of any UI/state coupling. Higher layers register
// notification handlers (e.g. for `turn/started`, `item/started`, …) by method.

import { createDeferred, Deferred, withTimeout } from "../lib/deferred";
import { makeLogger } from "../lib/log";
import type { JsonRpcError, JsonRpcMessage, JsonRpcSuccess } from "./types";

const log = makeLogger("jsonrpc");
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export type NotificationHandler = (params: unknown, method: string) => void;

export type ServerRequestHandler = (params: unknown) => Promise<unknown>;

export interface JsonRpcTransport {
  send(payloadText: string): void;
}

export interface JsonRpcOptions {
  /** Optional latency observer — called on every successful response with the
   *  measured round-trip time. UI layers wire this to a small store; tests
   *  can plug in a spy to assert timing without touching protocol internals. */
  onLatencySample?: (method: string, milliseconds: number) => void;
}

export class JsonRpcClient {
  private nextId = 1;
  private readonly pending = new Map<number | string, { deferred: Deferred<unknown>; method: string; startedAt: number }>();
  private readonly notificationHandlers = new Map<string, Set<NotificationHandler>>();
  private readonly serverRequestHandlers = new Map<string, ServerRequestHandler>();
  private readonly options: JsonRpcOptions;

  constructor(private readonly transport: JsonRpcTransport, options: JsonRpcOptions = {}) {
    this.options = options;
  }

  request<R = unknown, P = unknown>(method: string, params?: P, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<R> {
    const id = this.nextId++;
    const deferred = createDeferred<unknown>();
    this.pending.set(id, { deferred, method, startedAt: nowMs() });
    this.transport.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return withTimeout(deferred.promise, timeoutMs, `${method} timed out after ${timeoutMs}ms`).then(
      (value) => value as R,
      (error) => {
        this.pending.delete(id);
        throw error;
      }
    );
  }

  notify<P = unknown>(method: string, params?: P): void {
    this.transport.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  /** Register a handler for an inbound JSON-RPC notification. Returns an unsubscribe fn. */
  onNotification(method: string, handler: NotificationHandler): () => void {
    let set = this.notificationHandlers.get(method);
    if (!set) {
      set = new Set();
      this.notificationHandlers.set(method, set);
    }
    set.add(handler);
    return () => set?.delete(handler);
  }

  /** Register a handler for an inbound server-initiated JSON-RPC request (e.g. approvals). */
  onServerRequest(method: string, handler: ServerRequestHandler): () => void {
    this.serverRequestHandlers.set(method, handler);
    return () => this.serverRequestHandlers.delete(method);
  }

  handleIncomingPayload(payloadText: string): void {
    let parsed: JsonRpcMessage;
    try {
      parsed = JSON.parse(payloadText) as JsonRpcMessage;
    } catch (error) {
      log.warn("invalid JSON-RPC payload", error);
      return;
    }
    if ("id" in parsed && parsed.id !== null && parsed.id !== undefined && !("method" in parsed)) {
      this.resolvePending(parsed as JsonRpcSuccess | JsonRpcError);
      return;
    }
    if ("method" in parsed && parsed.method) {
      if ("id" in parsed && parsed.id !== null && parsed.id !== undefined) {
        void this.dispatchServerRequest(parsed.method, parsed.params, parsed.id);
        return;
      }
      this.dispatchNotification(parsed.method, parsed.params);
    }
  }

  rejectAllPending(reason: Error): void {
    for (const [, entry] of this.pending) entry.deferred.reject(reason);
    this.pending.clear();
  }

  private resolvePending(message: JsonRpcSuccess | JsonRpcError): void {
    const entry = this.pending.get(message.id as number | string);
    if (!entry) {
      log.warn("response for unknown id", message.id);
      return;
    }
    this.pending.delete(message.id as number | string);
    if ("error" in message) {
      entry.deferred.reject(new JsonRpcRemoteError(message.error.message, message.error.code, message.error.data));
    } else {
      entry.deferred.resolve(message.result);
    }
    // Latency observation runs after settling so a sample reflects the same
    // event the caller saw. We only sample successful responses — errors
    // can be quick (`-32601 method not found`) and would skew the median.
    if (!("error" in message)) {
      try {
        this.options.onLatencySample?.(entry.method, nowMs() - entry.startedAt);
      } catch (error) {
        log.warn("latency observer threw", error);
      }
    }
  }

  private dispatchNotification(method: string, params: unknown): void {
    const handlers = this.notificationHandlers.get(method);
    if (!handlers || handlers.size === 0) return;
    for (const handler of handlers) {
      try {
        handler(params, method);
      } catch (error) {
        log.error("notification handler threw", method, error);
      }
    }
  }

  private async dispatchServerRequest(method: string, params: unknown, id: number | string): Promise<void> {
    const handler = this.serverRequestHandlers.get(method);
    if (!handler) {
      this.transport.send(
        JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } })
      );
      return;
    }
    try {
      const result = await handler(params);
      this.transport.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
    } catch (error) {
      const remote = error as { message?: string; code?: number };
      this.transport.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: { code: remote.code ?? -32000, message: remote.message ?? "Handler error" },
        })
      );
    }
  }
}

export class JsonRpcRemoteError extends Error {
  constructor(message: string, public code: number, public data?: unknown) {
    super(message);
    this.name = "JsonRpcRemoteError";
  }
}
