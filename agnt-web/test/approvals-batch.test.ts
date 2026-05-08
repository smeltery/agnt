// Batch decideAllOfKind: every queued approval whose kind matches resolves
// with the same decision; resolvers are unwound; queue drops to entries of
// other kinds.

import { beforeEach, describe, expect, it } from "vitest";
import { type ApprovalDecision, type ApprovalRequest, useApprovalsStore } from "../src/state/approvals-store";

beforeEach(() => {
  useApprovalsStore.setState({ queue: [] });
});

function enqueue(kind: ApprovalRequest["kind"], id: string): Promise<ApprovalDecision> {
  return new Promise<ApprovalDecision>((resolve) => {
    useApprovalsStore.getState().enqueue(
      {
        id,
        kind,
        method: "test",
        rawParams: {},
      },
      resolve
    );
  });
}

describe("decideAllOfKind", () => {
  it("resolves every matching queued approval and removes them from the queue", async () => {
    const a = enqueue("command", "1");
    const b = enqueue("command", "2");
    const c = enqueue("fileChange", "3");
    const count = useApprovalsStore.getState().decideAllOfKind("command", "accept");
    expect(count).toBe(2);
    expect(await a).toBe("accept");
    expect(await b).toBe("accept");
    expect(useApprovalsStore.getState().queue.map((entry) => entry.id)).toEqual(["3"]);
    // The other-kind entry stays unresolved until someone decides on it.
    useApprovalsStore.getState().decide("3", "decline");
    expect(await c).toBe("decline");
  });

  it("returns 0 and is a no-op when nothing matches", () => {
    const count = useApprovalsStore.getState().decideAllOfKind("command", "accept");
    expect(count).toBe(0);
    expect(useApprovalsStore.getState().queue).toEqual([]);
  });

  it("can decline all of one kind without touching others", async () => {
    const a = enqueue("fileChange", "1");
    const b = enqueue("fileChange", "2");
    const c = enqueue("command", "3");
    useApprovalsStore.getState().decideAllOfKind("fileChange", "decline");
    expect(await a).toBe("decline");
    expect(await b).toBe("decline");
    expect(useApprovalsStore.getState().queue.map((entry) => entry.id)).toEqual(["3"]);
    useApprovalsStore.getState().decide("3", "accept");
    expect(await c).toBe("accept");
  });
});
