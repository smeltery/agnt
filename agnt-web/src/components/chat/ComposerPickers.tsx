import { useEffect, useRef } from "react";
import { formatMentionPath } from "../../lib/file-mention";
import { computeDraftStats, formatCount } from "../../lib/draft-stats";
import { describeBodyArgs } from "../../lib/slash-variables";
import { ClockArrowCirclepath } from "../shared/Icon";
import type { ComposerSurfaceProps } from "./ComposerSurface";

export function ComposerSlashMenu({
  customSlashCommands,
  slashCursor,
  slashMatches,
  slashQuery,
  onRunSlashCommand,
}: ComposerSurfaceProps) {
  if (slashQuery === null) return null;
  if (slashMatches.length === 0) {
    return <div className="agnt-slash-empty">No matching commands. Press Esc to dismiss or keep typing.</div>;
  }
  return (
    <div className="agnt-slash-menu" role="listbox" aria-label="Slash commands">
      {slashMatches.map((command, index) => {
        const custom = customSlashCommands.find((c) => c.name === command.name);
        const argShape = custom ? describeBodyArgs(custom.body) : { positional: 0, arguments: false };
        const hint = argShape.arguments
          ? "<args…>"
          : argShape.positional > 0
            ? Array.from({ length: argShape.positional }, (_, i) => `<${i + 1}>`).join(" ")
            : "";
        return (
          <button
            key={command.name}
            type="button"
            role="option"
            aria-selected={index === slashCursor}
            className={"agnt-slash-item" + (index === slashCursor ? " agnt-slash-item-active" : "")}
            onMouseDown={(event) => {
              event.preventDefault();
              onRunSlashCommand(command);
            }}
          >
            <code className="agnt-slash-item-name">
              /{command.name}
              {hint && <span className="agnt-slash-item-args"> {hint}</span>}
            </code>
            <span className="agnt-slash-item-description">{command.description}</span>
          </button>
        );
      })}
    </div>
  );
}

export function ComposerMentionMenu({
  mentionContext,
  mentionCursor,
  mentionCwd,
  mentionLoading,
  mentionMatches,
  onApplyMention,
}: ComposerSurfaceProps) {
  if (!mentionContext) return null;
  if (mentionMatches.length === 0 && mentionLoading) return <div className="agnt-slash-empty">Searching files…</div>;
  if (mentionMatches.length === 0) {
    return (
      <div className="agnt-slash-empty">
        {mentionCwd ? "No files match — Esc to dismiss or keep typing." : "Pick a project (set the thread cwd) to search files."}
      </div>
    );
  }
  return (
    <div className="agnt-slash-menu" role="listbox" aria-label="File mentions">
      {mentionMatches.map((entry, index) => (
        <button
          key={entry.path}
          type="button"
          role="option"
          aria-selected={index === mentionCursor}
          className={"agnt-slash-item" + (index === mentionCursor ? " agnt-slash-item-active" : "")}
          onMouseDown={(event) => {
            event.preventDefault();
            onApplyMention(entry);
          }}
        >
          <code className="agnt-slash-item-name">{entry.name}</code>
          <span className="agnt-slash-item-description">{formatMentionPath(entry.path, mentionCwd ?? "")}</span>
        </button>
      ))}
    </div>
  );
}

export function PromptHistoryDropdown({
  open,
  history,
  onPick,
  onOpenChange,
}: {
  open: boolean;
  history: string[];
  onPick(text: string): void;
  onOpenChange(open: boolean): void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!ref.current) return;
      if (!ref.current.contains(event.target as Node)) onOpenChange(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onOpenChange]);

  if (history.length === 0) {
    return (
      <button
        type="button"
        className="agnt-button-ghost agnt-button-ghost-disabled"
        title="No prompt history yet for this thread"
        aria-label="Prompt history (empty)"
        disabled
      >
        <ClockArrowCirclepath />
      </button>
    );
  }

  const recent = history.slice(-25).reverse();
  return (
    <div className="agnt-prompt-history" ref={ref}>
      <button
        type="button"
        className={"agnt-button-ghost" + (open ? " agnt-button-ghost-active" : "")}
        onClick={() => onOpenChange(!open)}
        title={open ? "Close prompt history" : "Browse past prompts"}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label="Prompt history"
      >
        <ClockArrowCirclepath />
      </button>
      {open && (
        <div className="agnt-prompt-history-popover" role="listbox" aria-label="Prompt history">
          {recent.map((text, index) => (
            <button
              key={index}
              type="button"
              role="option"
              className="agnt-prompt-history-item"
              onClick={() => onPick(text)}
              aria-selected={false}
              title={text}
            >
              {text.length > 80 ? text.slice(0, 77).trimEnd() + "…" : text}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function DraftStatsFooter({ draft }: { draft: string }) {
  const stats = computeDraftStats(draft);
  if (stats.chars === 0) return null;
  return (
    <div className="agnt-composer-stats" aria-live="polite">
      {formatCount(stats.chars)} chars · {formatCount(stats.words)} {stats.words === 1 ? "word" : "words"} · ~
      {formatCount(stats.approxTokens)} tokens
    </div>
  );
}
