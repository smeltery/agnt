// Structured user-input prompts. The bridge sends `tool/requestUserInput` (or
// `item/tool/requestUserInput`) as a server-initiated JSON-RPC request when an
// agent needs the user to answer one or more questions. Each question can be
// open-ended text, secret text, or a (single-/multi-)select with options.
// Mirrors CodexService+IncomingPlanMode.swift's decodeStructuredUserInputQuestions.

import { create } from "zustand";

export interface StructuredInputOption {
  label: string;
  description?: string;
}

export interface StructuredInputQuestion {
  id: string;
  header?: string;
  question: string;
  isSecret: boolean;
  isOther: boolean;
  selectionLimit?: number;
  options: StructuredInputOption[];
}

export interface StructuredInputPrompt {
  id: string; // JSON-RPC request id
  threadId?: string;
  turnId?: string;
  itemId?: string;
  questions: StructuredInputQuestion[];
}

interface PendingResolver {
  prompt: StructuredInputPrompt;
  resolve: (answers: StructuredInputAnswerPayload) => void;
}

export interface StructuredInputAnswer {
  questionId: string;
  values: string[]; // free text → single-element; multi-select → list of labels
}

export interface StructuredInputAnswerPayload {
  cancelled?: boolean;
  answers?: StructuredInputAnswer[];
}

interface State {
  queue: StructuredInputPrompt[];
  enqueue(prompt: StructuredInputPrompt, resolve: (answers: StructuredInputAnswerPayload) => void): void;
  submit(promptId: string, answers: StructuredInputAnswer[]): void;
  cancel(promptId: string): void;
  clearAll(): void;
}

const resolvers = new Map<string, PendingResolver>();

export const useStructuredInputStore = create<State>((set, get) => ({
  queue: [],
  enqueue(prompt, resolve) {
    resolvers.set(prompt.id, { prompt, resolve });
    const queue = get().queue.filter((existing) => existing.id !== prompt.id);
    set({ queue: [...queue, prompt] });
  },
  submit(promptId, answers) {
    const entry = resolvers.get(promptId);
    if (!entry) return;
    resolvers.delete(promptId);
    entry.resolve({ answers });
    set({ queue: get().queue.filter((prompt) => prompt.id !== promptId) });
  },
  cancel(promptId) {
    const entry = resolvers.get(promptId);
    if (!entry) return;
    resolvers.delete(promptId);
    entry.resolve({ cancelled: true });
    set({ queue: get().queue.filter((prompt) => prompt.id !== promptId) });
  },
  clearAll() {
    for (const [, entry] of resolvers) entry.resolve({ cancelled: true });
    resolvers.clear();
    set({ queue: [] });
  },
}));

export function buildStructuredInputServerRequestHandler(): (params: unknown) => Promise<unknown> {
  return async (params) => {
    const prompt = decodePrompt(params);
    if (!prompt) return { cancelled: true };
    return await new Promise<StructuredInputAnswerPayload>((resolve) => {
      useStructuredInputStore.getState().enqueue(prompt, resolve);
    });
  };
}

function decodePrompt(params: unknown): StructuredInputPrompt | null {
  if (!params || typeof params !== "object") return null;
  const obj = params as Record<string, unknown>;
  const id = readString(obj, "requestId", "id") ?? crypto.randomUUID();
  const questions = decodeQuestions(obj.questions);
  if (questions.length === 0) return null;
  return {
    id,
    threadId: readString(obj, "threadId"),
    turnId: readString(obj, "turnId"),
    itemId: readString(obj, "itemId"),
    questions,
  };
}

function decodeQuestions(value: unknown): StructuredInputQuestion[] {
  if (!Array.isArray(value)) return [];
  const out: StructuredInputQuestion[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const id = readString(record, "id");
    const question = readString(record, "question");
    if (!id || !question) continue;
    out.push({
      id,
      header: readString(record, "header"),
      question,
      isOther: Boolean(record.isOther),
      isSecret: Boolean(record.isSecret),
      selectionLimit:
        typeof record.selectionLimit === "number"
          ? record.selectionLimit
          : typeof record.selection_limit === "number"
            ? record.selection_limit
            : undefined,
      options: decodeOptions(record.options),
    });
  }
  return out;
}

function decodeOptions(value: unknown): StructuredInputOption[] {
  if (!Array.isArray(value)) return [];
  const out: StructuredInputOption[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const label = readString(record, "label");
    if (!label) continue;
    out.push({ label, description: readString(record, "description") });
  }
  return out;
}

function readString(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}
