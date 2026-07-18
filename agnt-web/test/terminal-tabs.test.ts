import { describe, expect, it } from "vitest";
import {
  closeTerminalTab,
  createTerminalTab,
  terminalTabSubtitle,
  type TerminalTab,
} from "../src/components/terminal/terminal-tabs";
import type { TerminalSnapshot } from "../src/protocol/terminal";

describe("terminal tabs", () => {
  it("allocates the next unused terminal id", () => {
    const tabs: TerminalTab[] = [
      { id: "term-1", title: "Terminal 1" },
      { id: "term-3", title: "Terminal 3" },
    ];

    expect(createTerminalTab(tabs)).toEqual({ id: "term-4", title: "Terminal 4" });
  });

  it("keeps the active terminal when closing an inactive tab", () => {
    const result = closeTerminalTab(
      [
        { id: "term-1", title: "Terminal 1" },
        { id: "term-2", title: "Terminal 2" },
      ],
      "term-1",
      "term-2"
    );

    expect(result.activeId).toBe("term-1");
    expect(result.tabs).toEqual([{ id: "term-1", title: "Terminal 1" }]);
  });

  it("moves active selection to the next available tab", () => {
    const result = closeTerminalTab(
      [
        { id: "term-1", title: "Terminal 1" },
        { id: "term-2", title: "Terminal 2" },
        { id: "term-3", title: "Terminal 3" },
      ],
      "term-2",
      "term-2"
    );

    expect(result.activeId).toBe("term-3");
    expect(result.tabs.map((tab) => tab.id)).toEqual(["term-1", "term-3"]);
  });

  it("shows cwd basename in tab subtitles", () => {
    expect(terminalTabSubtitle(snapshot("/Users/nicholas/project"))).toBe("project");
    expect(terminalTabSubtitle(snapshot(""))).toBe("bridge host");
  });
});

function snapshot(cwd: string): TerminalSnapshot {
  return {
    terminalId: "term-1",
    instanceId: "instance-1",
    status: "running",
    cols: 80,
    rows: 24,
    cwd,
    historyBase64: "",
    errorMessage: null,
    resizeSupported: true,
  };
}
