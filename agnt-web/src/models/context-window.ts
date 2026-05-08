// ContextWindowUsage extractor. Faithful port of
// CodexService+IncomingSupport.swift:145-256 (extractContextWindowUsage).
// The bridge inconsistently publishes token info under a wide alias set; this
// helper normalizes whichever shape arrived.

const TOKENS_USED_KEYS = [
  "tokensUsed",
  "tokens_used",
  "totalTokens",
  "total_tokens",
  "usedTokens",
  "used_tokens",
  "inputTokens",
  "input_tokens",
];
const TOKEN_LIMIT_KEYS = [
  "tokenLimit",
  "token_limit",
  "maxTokens",
  "max_tokens",
  "contextWindow",
  "context_window",
  "contextSize",
  "context_size",
  "maxContextTokens",
  "max_context_tokens",
  "inputTokenLimit",
  "input_token_limit",
  "maxInputTokens",
  "max_input_tokens",
];
const TOKENS_REMAINING_KEYS = [
  "tokensRemaining",
  "tokens_remaining",
  "remainingTokens",
  "remaining_tokens",
  "remainingInputTokens",
  "remaining_input_tokens",
];

export interface ContextWindowUsage {
  tokensUsed: number;
  tokenLimit: number;
}

export function extractContextWindowUsage(payload: unknown): ContextWindowUsage | null {
  if (!payload || typeof payload !== "object") return null;
  const tokensUsed = firstNumericKey(payload, TOKENS_USED_KEYS);
  const explicitLimit = firstNumericKey(payload, TOKEN_LIMIT_KEYS);
  const tokensRemaining = firstNumericKey(payload, TOKENS_REMAINING_KEYS);

  const tokenLimit =
    explicitLimit ??
    (tokensRemaining !== null && tokensUsed !== null ? tokensUsed + Math.max(0, tokensRemaining) : null);
  if (tokenLimit === null || !(tokenLimit > 0)) return null;
  const used = tokensUsed === null ? 0 : Math.max(0, Math.min(tokensUsed, tokenLimit));
  return { tokensUsed: used, tokenLimit };
}

export function fractionUsed(usage: ContextWindowUsage): number {
  if (usage.tokenLimit <= 0) return 0;
  return Math.min(1, usage.tokensUsed / usage.tokenLimit);
}

function firstNumericKey(payload: unknown, keys: string[]): number | null {
  if (!payload || typeof payload !== "object") return null;
  for (const key of keys) {
    const value = (payload as Record<string, unknown>)[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  // Some bridges nest the usage under a sub-object (e.g. params.info.tokensUsed).
  const nested = (payload as Record<string, unknown>).info ?? (payload as Record<string, unknown>).usage;
  if (nested && typeof nested === "object") return firstNumericKey(nested, keys);
  return null;
}
