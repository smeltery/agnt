import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { looksLikeTextFile } from "../../lib/text-attach";
import { formatMentionPath, searchFilesForMention } from "../../lib/file-mention";
import { applyMentionReplacement, detectMention, type MentionContext } from "../../lib/mention-detector";
import type { ImageAttachment } from "../../models";
import type { ProjectDirectoryEntry } from "../../protocol/project";
import { useConnectionStore } from "../../state/connection-store";
import { useCustomSlashCommandsStore } from "../../state/custom-slash-commands-store";
import { parseSlashArgs } from "../../lib/slash-variables";
import { filterSlashCommands, type SlashCommand } from "../../state/slash-commands";
import { selectActiveMessages, useThreadsStore } from "../../state/threads-store";
import { ComposerSurface } from "./ComposerSurface";
import { useComposerAttachments } from "./useComposerAttachments";
import { useComposerDraftLifecycle } from "./useComposerDraftLifecycle";

export interface ComposerProps {
  running: boolean;
  onSend: (text: string, attachments: ImageAttachment[]) => void;
  onStop: () => void;
}

export function Composer({ running, onSend, onStop }: ComposerProps) {
  const [draft, setDraft] = useState("");
  const {
    attachError,
    attachments,
    ingestFiles,
    removeAttachment,
    reorderAttachments,
    setAttachError,
    setAttachments,
  } = useComposerAttachments(setDraft);
  const [dragSourceId, setDragSourceId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);

  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [findReplaceOpen, setFindReplaceOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [expandedOpen, setExpandedOpen] = useState(false);
  const expandedTextareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!expandedOpen) return;
    expandedTextareaRef.current?.focus();
    const end = draft.length;
    expandedTextareaRef.current?.setSelectionRange(end, end);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpandedOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandedOpen]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messages = useThreadsStore(selectActiveMessages);
  const userPromptHistory = useMemo(
    () =>
      messages
        .filter((message) => message.role === "user" && message.text.trim())
        .map((message) => message.text),
    [messages]
  );
  const [historyCursor, setHistoryCursor] = useState(-1);
  const draftBeforeRecallRef = useRef<string>("");
  const resetHistory = useCallback(() => {
    setHistoryCursor(-1);
    draftBeforeRecallRef.current = "";
  }, []);
  const selectedThreadId = useThreadsStore((state) => state.selectedThreadId);
  const { clearPersistedDraft } = useComposerDraftLifecycle({ draft, selectedThreadId, setDraft, resetHistory });

  const slashState = useMemo(() => {
    if (!draft.startsWith("/")) return null;
    if (draft.includes("\n")) return null;
    const rest = draft.slice(1);
    const firstSpace = rest.search(/\s/);
    if (firstSpace < 0) return { name: rest, rawArgs: "" };
    return { name: rest.slice(0, firstSpace), rawArgs: rest.slice(firstSpace + 1) };
  }, [draft]);
  const slashQuery = slashState?.name ?? null;
  const customSlashCommands = useCustomSlashCommandsStore((state) => state.commands);
  const slashMatches = useMemo(() => {
    if (slashQuery === null) return [];
    return filterSlashCommands(
      slashQuery,
      {
        threadId: selectedThreadId ?? "",
        threads: useThreadsStore.getState(),
      },
      customSlashCommands
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slashQuery, selectedThreadId, customSlashCommands]);
  const [slashCursor, setSlashCursor] = useState(0);
  useEffect(() => {
    setSlashCursor(0);
  }, [slashMatches.length]);

  const [mentionContext, setMentionContext] = useState<MentionContext | null>(null);
  const [mentionMatches, setMentionMatches] = useState<ProjectDirectoryEntry[]>([]);
  const [mentionCursor, setMentionCursor] = useState(0);
  const [mentionLoading, setMentionLoading] = useState(false);
  const connection = useConnectionStore((state) => state.connection);
  const activeThread = useThreadsStore((state) => {
    if (!state.selectedThreadId) return undefined;
    return state.threads.find((t) => t.id === state.selectedThreadId)
      ?? state.archivedThreads.find((t) => t.id === state.selectedThreadId);
  });
  const mentionCwd = activeThread?.cwd;

  useEffect(() => {
    if (!mentionContext || !connection?.rpc || !mentionCwd) {
      setMentionMatches([]);
      return;
    }
    let cancelled = false;
    setMentionLoading(true);
    const handle = window.setTimeout(async () => {
      try {
        const entries = await searchFilesForMention(connection.rpc, mentionCwd, mentionContext.query);
        if (!cancelled) {
          setMentionMatches(entries);
          setMentionCursor(0);
        }
      } catch {
        if (!cancelled) setMentionMatches([]);
      } finally {
        if (!cancelled) setMentionLoading(false);
      }
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [mentionContext, connection?.rpc, mentionCwd]);

  function updateMentionContext(text: string, caret: number) {
    if (slashQuery !== null) {
      setMentionContext(null);
      return;
    }
    if (!mentionCwd) {
      setMentionContext(null);
      return;
    }
    setMentionContext(detectMention(text, caret));
  }

  useLayoutEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    const computed = window.getComputedStyle(ta);
    const lineHeight = parseFloat(computed.lineHeight) || 18;
    const paddingY = parseFloat(computed.paddingTop) + parseFloat(computed.paddingBottom);
    const maxHeight = lineHeight * 10 + paddingY;
    ta.style.height = Math.min(ta.scrollHeight, maxHeight) + "px";
    ta.style.overflowY = ta.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [draft]);

  function applyMention(entry: ProjectDirectoryEntry) {
    if (!mentionContext) return;
    const path = formatMentionPath(entry.path, mentionCwd ?? "");
    const { text, caret } = applyMentionReplacement(draft, mentionContext, path);
    setDraft(text);
    setMentionContext(null);
    setMentionMatches([]);
    requestAnimationFrame(() => {
      if (!textareaRef.current) return;
      textareaRef.current.focus();
      textareaRef.current.setSelectionRange(caret, caret);
    });
  }

  function runSlashCommand(command: SlashCommand) {
    const ta = textareaRef.current;
    const selection = ta && ta.selectionStart !== ta.selectionEnd
      ? ta.value.slice(ta.selectionStart, ta.selectionEnd)
      : "";
    const args = slashState ? parseSlashArgs(slashState.rawArgs) : [];
    const context = {
      threadId: selectedThreadId ?? "",
      threads: useThreadsStore.getState(),
      args,
      variables: {
        cwd: activeThread?.cwd,
        threadTitle: activeThread?.name ?? activeThread?.title,
        selection,
        args,
      },
    };
    if (command.expand) {
      const body = command.expand(context);
      setDraft(body);
      setHistoryCursor(-1);
      draftBeforeRecallRef.current = "";
      setSlashCursor(0);
      requestAnimationFrame(() => {
        const input = document.getElementById("agnt-composer-input") as HTMLTextAreaElement | null;
        if (input) {
          input.focus();
          input.setSelectionRange(body.length, body.length);
        }
      });
      return;
    }
    setDraft("");
    setHistoryCursor(-1);
    draftBeforeRecallRef.current = "";
    setSlashCursor(0);
    void command.run(context);
  }

  function recallStep(direction: "older" | "newer") {
    if (userPromptHistory.length === 0) return;
    const lastIndex = userPromptHistory.length - 1;
    setHistoryCursor((current) => {
      let next = current;
      if (direction === "older") {
        if (current === -1) {
          draftBeforeRecallRef.current = draft;
          next = 0;
        } else if (current < lastIndex) {
          next = current + 1;
        }
      } else if (current >= 0) {
        next = current - 1;
      }
      if (next === -1) {
        setDraft(draftBeforeRecallRef.current);
      } else if (next !== current) {
        setDraft(userPromptHistory[lastIndex - next]);
      }
      return next;
    });
  }

  function submit() {
    if (slashQuery !== null && slashMatches.length > 0) {
      runSlashCommand(slashMatches[Math.min(slashCursor, slashMatches.length - 1)]);
      return;
    }
    const text = draft.trim();
    if (!text && attachments.length === 0) return;
    if (running) return;
    onSend(text, attachments);
    setDraft("");
    setAttachments([]);
    setAttachError(null);
    setHistoryCursor(-1);
    draftBeforeRecallRef.current = "";
    if (selectedThreadId) clearPersistedDraft();
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    submit();
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && (event.key === "f" || event.key === "F")) {
      event.preventDefault();
      setFindReplaceOpen(true);
      return;
    }
    if (mentionContext && mentionMatches.length > 0) {
      if (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        applyMention(mentionMatches[Math.min(mentionCursor, mentionMatches.length - 1)]);
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setMentionCursor((current) => (current + 1) % mentionMatches.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setMentionCursor((current) => (current - 1 + mentionMatches.length) % mentionMatches.length);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setMentionContext(null);
        return;
      }
    }
    if (slashQuery !== null && slashMatches.length > 0) {
      if (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        runSlashCommand(slashMatches[Math.min(slashCursor, slashMatches.length - 1)]);
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSlashCursor((current) => (current + 1) % slashMatches.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSlashCursor((current) => (current - 1 + slashMatches.length) % slashMatches.length);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setDraft("");
        return;
      }
      if (event.key === "Tab" && !event.shiftKey) {
        event.preventDefault();
        const completion = slashMatches[Math.min(slashCursor, slashMatches.length - 1)];
        setDraft(`/${completion.name}`);
        return;
      }
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
      return;
    }
    if (event.key === "ArrowUp" && (historyCursor >= 0 || draft === "")) {
      event.preventDefault();
      recallStep("older");
      return;
    }
    if (event.key === "ArrowDown" && historyCursor >= 0) {
      event.preventDefault();
      recallStep("newer");
      return;
    }
    if (event.key === "Escape" && historyCursor >= 0) {
      event.preventDefault();
      setHistoryCursor(-1);
      setDraft(draftBeforeRecallRef.current);
    }
  }

  function onDraftChange(value: string) {
    setDraft(value);
    if (historyCursor !== -1) {
      setHistoryCursor(-1);
      draftBeforeRecallRef.current = "";
    }
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      updateMentionContext(value, ta.selectionStart ?? value.length);
    });
  }

  function handleCaretMove(event: React.SyntheticEvent<HTMLTextAreaElement>) {
    const ta = event.currentTarget;
    updateMentionContext(ta.value, ta.selectionStart ?? ta.value.length);
  }

  function handlePaste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const items = event.clipboardData.items;
    const files: File[] = [];
    for (const item of items) {
      if (item.kind !== "file") continue;
      const file = item.getAsFile();
      if (!file) continue;
      if (file.type.startsWith("image/") || looksLikeTextFile(file)) files.push(file);
    }
    if (files.length > 0) {
      event.preventDefault();
      void ingestFiles(files);
    }
  }

  return (
    <ComposerSurface
      activeThreadId={selectedThreadId}
      attachError={attachError}
      attachments={attachments}
      customSlashCommands={customSlashCommands}
      draft={draft}
      dragSourceId={dragSourceId}
      dropTargetId={dropTargetId}
      expandedOpen={expandedOpen}
      expandedTextareaRef={expandedTextareaRef}
      fileInputRef={fileInputRef}
      findReplaceOpen={findReplaceOpen}
      history={userPromptHistory}
      historyOpen={historyOpen}
      isDraggingFile={isDraggingFile}
      mentionContext={mentionContext}
      mentionCursor={mentionCursor}
      mentionCwd={mentionCwd}
      mentionLoading={mentionLoading}
      mentionMatches={mentionMatches}
      previewOpen={previewOpen}
      running={running}
      slashCursor={slashCursor}
      slashMatches={slashMatches}
      slashQuery={slashQuery}
      textareaRef={textareaRef}
      onApplyMention={applyMention}
      onAttachInputChange={(files) => {
        void ingestFiles(files);
      }}
      onCaretMove={handleCaretMove}
      onCloseExpanded={() => setExpandedOpen(false)}
      onCloseFindReplace={() => setFindReplaceOpen(false)}
      onDraftChange={onDraftChange}
      onDragFileChange={setIsDraggingFile}
      onDropFiles={(files) => {
        void ingestFiles(files);
      }}
      onDropTargetChange={setDropTargetId}
      onExpandedOpenChange={setExpandedOpen}
      onHistoryOpenChange={setHistoryOpen}
      onHistoryPick={(text) => {
        setDraft(text);
        setHistoryCursor(-1);
        draftBeforeRecallRef.current = "";
        setHistoryOpen(false);
        requestAnimationFrame(() => {
          const ta = textareaRef.current;
          if (!ta) return;
          ta.focus();
          ta.setSelectionRange(text.length, text.length);
        });
      }}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
      onPreviewOpenChange={setPreviewOpen}
      onRemoveAttachment={removeAttachment}
      onReorderAttachments={reorderAttachments}
      onRunSlashCommand={runSlashCommand}
      onSendExpanded={() => {
        if (draft.trim() || attachments.length > 0) {
          onSend(draft, attachments);
          onDraftChange("");
          setExpandedOpen(false);
        }
      }}
      onSubmit={handleSubmit}
      onDragSourceChange={setDragSourceId}
      onStop={onStop}
    />
  );
}
