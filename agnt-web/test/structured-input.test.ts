import { beforeEach, describe, expect, it } from "vitest";
import {
  buildStructuredInputServerRequestHandler,
  useStructuredInputStore,
} from "../src/state/structured-input-store";

beforeEach(() => useStructuredInputStore.getState().clearAll());

describe("structured input store", () => {
  it("decodes a multi-question prompt and resolves with answers on submit", async () => {
    const handler = buildStructuredInputServerRequestHandler();
    const responsePromise = handler({
      requestId: "r-1",
      threadId: "t",
      questions: [
        { id: "q1", question: "Pick one", options: [{ label: "A" }, { label: "B" }], selectionLimit: 1 },
        { id: "q2", header: "Free text", question: "Your name?", isSecret: false },
      ],
    });
    const queue = useStructuredInputStore.getState().queue;
    expect(queue).toHaveLength(1);
    expect(queue[0].questions).toHaveLength(2);
    useStructuredInputStore.getState().submit("r-1", [
      { questionId: "q1", values: ["A"] },
      { questionId: "q2", values: ["Alice"] },
    ]);
    await expect(responsePromise).resolves.toEqual({
      answers: [
        { questionId: "q1", values: ["A"] },
        { questionId: "q2", values: ["Alice"] },
      ],
    });
  });

  it("returns cancelled:true when the user cancels", async () => {
    const handler = buildStructuredInputServerRequestHandler();
    const responsePromise = handler({ questions: [{ id: "q1", question: "?" }] });
    const id = useStructuredInputStore.getState().queue[0].id;
    useStructuredInputStore.getState().cancel(id);
    await expect(responsePromise).resolves.toEqual({ cancelled: true });
  });

  it("falls back to cancelled:true when params have no usable questions", async () => {
    const handler = buildStructuredInputServerRequestHandler();
    await expect(handler({ questions: [] })).resolves.toEqual({ cancelled: true });
    await expect(handler({})).resolves.toEqual({ cancelled: true });
  });

  it("normalizes both selectionLimit and selection_limit aliases", async () => {
    const handler = buildStructuredInputServerRequestHandler();
    void handler({
      questions: [
        { id: "q1", question: "?", options: [{ label: "X" }], selection_limit: 3 },
      ],
    });
    expect(useStructuredInputStore.getState().queue[0].questions[0].selectionLimit).toBe(3);
  });

  it("declines all queued prompts on clearAll", async () => {
    const handler = buildStructuredInputServerRequestHandler();
    const a = handler({ questions: [{ id: "a", question: "?" }] });
    const b = handler({ questions: [{ id: "b", question: "?" }] });
    useStructuredInputStore.getState().clearAll();
    await expect(a).resolves.toEqual({ cancelled: true });
    await expect(b).resolves.toEqual({ cancelled: true });
  });
});
