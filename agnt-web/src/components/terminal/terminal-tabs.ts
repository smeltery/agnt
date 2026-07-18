import type { TerminalSnapshot } from "../../protocol/terminal";

export interface TerminalTab {
  id: string;
  title: string;
}

export function createTerminalTab(existing: readonly TerminalTab[]): TerminalTab {
  const used = new Set(existing.map((tab) => tab.id));
  let index = existing.length + 1;
  let id = terminalIdForIndex(index);
  while (used.has(id)) {
    index += 1;
    id = terminalIdForIndex(index);
  }
  return { id, title: `Terminal ${index}` };
}

export function closeTerminalTab(
  tabs: readonly TerminalTab[],
  activeId: string,
  closingId: string
): { tabs: TerminalTab[]; activeId: string } {
  if (tabs.length <= 1) {
    return { tabs: [...tabs], activeId };
  }
  const closingIndex = Math.max(0, tabs.findIndex((tab) => tab.id === closingId));
  const nextTabs = tabs.filter((tab) => tab.id !== closingId);
  if (activeId !== closingId) {
    return { tabs: nextTabs, activeId };
  }
  const replacement = nextTabs[Math.min(closingIndex, nextTabs.length - 1)] ?? nextTabs[0];
  return { tabs: nextTabs, activeId: replacement.id };
}

export function terminalTabSubtitle(snapshot: TerminalSnapshot | undefined): string {
  const cwd = snapshot?.cwd?.trim();
  if (!cwd) return "bridge host";
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? cwd;
}

function terminalIdForIndex(index: number): string {
  return `term-${index}`;
}
