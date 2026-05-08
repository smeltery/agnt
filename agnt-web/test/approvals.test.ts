import { beforeEach, describe, expect, it } from "vitest";
import { buildApprovalServerRequestHandler, useApprovalsStore } from "../src/state/approvals-store";

beforeEach(() => useApprovalsStore.getState().clearAll());

describe("approvals store", () => {
  it("queues a pending request and resolves on accept", async () => {
    const handler = buildApprovalServerRequestHandler();
    const decisionPromise = handler(
      { threadId: "t", turnId: "u", itemId: "i", command: "rm -rf /tmp", reason: "cleanup" },
      "item/commandExecution/requestApproval"
    );
    const queue = useApprovalsStore.getState().queue;
    expect(queue).toHaveLength(1);
    expect(queue[0].kind).toBe("command");
    expect(queue[0].command).toBe("rm -rf /tmp");
    useApprovalsStore.getState().decide(queue[0].id, "accept");
    await expect(decisionPromise).resolves.toEqual({ decision: "accept" });
    expect(useApprovalsStore.getState().queue).toHaveLength(0);
  });

  it("supports acceptForSession decisions", async () => {
    const handler = buildApprovalServerRequestHandler();
    const decisionPromise = handler({}, "item/commandExecution/requestApproval");
    const id = useApprovalsStore.getState().queue[0].id;
    useApprovalsStore.getState().decide(id, "acceptForSession");
    await expect(decisionPromise).resolves.toEqual({ decision: "acceptForSession" });
  });

  it("declines all queued approvals on clearAll (e.g. socket dropped)", async () => {
    const handler = buildApprovalServerRequestHandler();
    const a = handler({}, "item/commandExecution/requestApproval");
    const b = handler({}, "item/fileChange/requestApproval");
    expect(useApprovalsStore.getState().queue).toHaveLength(2);
    useApprovalsStore.getState().clearAll();
    await expect(a).resolves.toEqual({ decision: "decline" });
    await expect(b).resolves.toEqual({ decision: "decline" });
    expect(useApprovalsStore.getState().queue).toHaveLength(0);
  });

  it("classifies methods that include unusual casing", async () => {
    const handler = buildApprovalServerRequestHandler();
    void handler({}, "item/file_change/request_approval");
    expect(useApprovalsStore.getState().queue[0].kind).toBe("fileChange");
    useApprovalsStore.getState().clearAll();
    void handler({}, "item/somethingElse/requestApproval");
    expect(useApprovalsStore.getState().queue[0].kind).toBe("other");
  });
});
