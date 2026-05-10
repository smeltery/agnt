import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { attachmentFromFile, ImageAttachError } from "../../lib/image-attach";
import { attachmentFromTextFile, looksLikeTextFile, TextAttachError } from "../../lib/text-attach";
import { formatMentionPath, searchFilesForMention } from "../../lib/file-mention";
import { applyMentionReplacement, detectMention, type MentionContext } from "../../lib/mention-detector";
import type { ImageAttachment } from "../../models";
import { computeDraftStats, formatCount } from "../../lib/draft-stats";
import type { ProjectDirectoryEntry } from "../../protocol/project";
import { useConnectionStore } from "../../state/connection-store";
import { useComposerInboxStore } from "../../state/composer-inbox-store";
import { useCustomSlashCommandsStore } from "../../state/custom-slash-commands-store";
import { describeBodyArgs, parseSlashArgs } from "../../lib/slash-variables";
import { filterSlashCommands, type SlashCommand } from "../../state/slash-commands";
import { selectActiveMessages, useThreadsStore } from "../../state/threads-store";
import { ComposerFindReplace } from "./ComposerFindReplace";
import { MarkdownContent } from "./MarkdownContent";
import { ClockArrowCirclepath, Eye, EyeSlash, Paperclip } from "../shared/Icon";
import { useVoiceStore } from "../../state/voice-store";
import { draftsStore } from "../../storage/drafts-store";
import { VoiceButton } from "./VoiceButton";

const DRAFT_SAVE_DEBOUNCE_MS = 400;

export interface ComposerProps {
  running: boolean;
  onSend: (text: string, attachments: ImageAttachment[]) => void;
  onStop: () => void;
}

export function Composer({ running, onSend, onStop }: ComposerProps) {
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [findReplaceOpen, setFindReplaceOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Composer history: up-arrow at an empty draft (or while the cursor is
  // already engaged) walks backward through past user prompts. Stays in sync
  // with the active thread's messages — switching threads resets the cursor.
  const messages = useThreadsStore(selectActiveMessages);
  const userPromptHistory = useMemo(
    () =>
      messages
        .filter((message) => message.role === "user" && message.text.trim())
        .map((message) => message.text),
    [messages]
  );
  // -1 = no recall (typing a fresh draft). 0 = most recent prompt, etc.
  const [historyCursor, setHistoryCursor] = useState(-1);
  const draftBeforeRecallRef = useRef<string>("");

  // Voice transcript drains on completion: when the voice-store stamps a new
  // transcript, append it (with a leading space if the draft already has text)
  // and clear the pending value. The store is the source of truth for the
  // arrival event so the composer doesn't double-apply a transcript.
  const pendingTranscript = useVoiceStore((state) => state.pendingTranscript);
  const consumeTranscript = useVoiceStore((state) => state.consumeTranscript);

  useEffect(() => {
    if (!pendingTranscript) return;
    const transcript = consumeTranscript();
    if (!transcript) return;
    setDraft((current) => (current.trim() ? `${current.trimEnd()} ${transcript}` : transcript));
    // Voice typically isn't used while browsing history, but if it is, the
    // appended transcript means the user is back to composing fresh.
    setHistoryCursor(-1);
    draftBeforeRecallRef.current = "";
  }, [pendingTranscript, consumeTranscript]);

  // Switching threads (or starting fresh) wipes the recall cursor — past
  // prompts from another thread shouldn't paste into this one — and hydrates
  // a previously-saved draft from disk so users can resume what they were
  // typing in a thread they left mid-composition.
  const selectedThreadId = useThreadsStore((state) => state.selectedThreadId);
  const previousThreadIdRef = useRef<string | null>(null);
  // Tracks whether the current `draft` value is the result of a hydrate so
  // the save effect can skip the no-op write.
  const draftHydratedFromRef = useRef<string>("");
  useEffect(() => {
    setHistoryCursor(-1);
    draftBeforeRecallRef.current = "";
    let cancelled = false;
    const previous = previousThreadIdRef.current;
    previousThreadIdRef.current = selectedThreadId;
    // Persist whatever the user had typed in the previous thread before
    // overwriting our state with the new thread's draft.
    if (previous && previous !== selectedThreadId) {
      void draftsStore.save(previous, draft);
    }
    if (!selectedThreadId) {
      setDraft("");
      draftHydratedFromRef.current = "";
      return;
    }
    void draftsStore.load(selectedThreadId).then((value) => {
      if (cancelled || previousThreadIdRef.current !== selectedThreadId) return;
      setDraft(value);
      draftHydratedFromRef.current = value;
    });
    return () => {
      cancelled = true;
    };
    // We intentionally read `draft` lazily here via a closure — including it
    // in the deps would persist on every keystroke, which the debounced
    // saver below already handles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedThreadId]);

  // Debounced persistence: every change to `draft` (when there's a thread)
  // schedules a save 400 ms later. The check against draftHydratedFromRef
  // suppresses the no-op write that would happen immediately after hydrate.
  useEffect(() => {
    if (!selectedThreadId) return;
    if (draft === draftHydratedFromRef.current) return;
    const timeoutId = window.setTimeout(() => {
      void draftsStore.save(selectedThreadId, draft);
      draftHydratedFromRef.current = draft;
    }, DRAFT_SAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(timeoutId);
  }, [draft, selectedThreadId]);

  // Inbox subscription: rows can ask the composer to prepend text via
  // useComposerInboxStore.request(...). We consume the slot on every change
  // so a Reply published while a different thread was active gets applied
  // the moment the user navigates back.
  const inboxPending = useComposerInboxStore((state) => state.pending);
  useEffect(() => {
    if (!selectedThreadId) return;
    const body = useComposerInboxStore.getState().consume(selectedThreadId);
    if (!body) return;
    setDraft((current) => (current.trim() ? `${body}${current}` : body));
    setHistoryCursor(-1);
    draftBeforeRecallRef.current = "";
  }, [inboxPending, selectedThreadId]);

  // beforeunload: best-effort sync drain so a tab close/navigation doesn't
  // lose the last few hundred ms of typing. IndexedDB writes can lag here;
  // there's no synchronous guarantee, but the debounce window is short and
  // most browsers honor in-flight writes long enough.
  useEffect(() => {
    if (!selectedThreadId) return;
    const handler = () => {
      void draftsStore.save(selectedThreadId, draft);
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [draft, selectedThreadId]);

  // Slash-menu surface. Matches when the draft starts with "/". The typed
  // text after "/" splits at the first whitespace into a command name + a
  // raw arg string; the menu filters on the name and the run path passes
  // the parsed args into the slash-variable expander so bodies with
  // `{1}` / `$ARGUMENTS` placeholders can interpolate them.
  //
  // We still want the menu to dismiss when the draft contains a newline —
  // that means the user has switched intents from "running a command" to
  // "typing a multi-line prompt that happens to start with a slash."
  const slashState = useMemo(() => {
    if (!draft.startsWith("/")) return null;
    if (draft.includes("\n")) return null;
    const rest = draft.slice(1);
    const firstSpace = rest.search(/\s/);
    if (firstSpace < 0) return { name: rest, rawArgs: "" };
    return { name: rest.slice(0, firstSpace), rawArgs: rest.slice(firstSpace + 1) };
  }, [draft]);
  const slashQuery = slashState?.name ?? null;
  // We need the snapshot at run-time, not on every render; subscribing the
  // whole component to threads-store would re-render on every streaming
  // delta. Instead grab the snapshot lazily inside the action handler.
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
    // The match list only depends on the typed query + which thread is
    // selected. canRun() is queried again at run time so a thread switch
    // mid-typing still picks the right command.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slashQuery, selectedThreadId, customSlashCommands]);
  const [slashCursor, setSlashCursor] = useState(0);
  // Reset the highlight cursor any time the visible match list changes.
  useEffect(() => {
    setSlashCursor(0);
  }, [slashMatches.length]);

  // @-file mention surface. Detection is caret-aware (not just "draft starts
  // with @") so users can drop file references in the middle of a sentence.
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

  // Debounced fetch when the mention query changes. We bail out if there's no
  // cwd (we'd have nothing to root the search against) or no rpc connection.
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
        // Bridge errors here (cwd permission, provider quirks) shouldn't
        // wedge the composer — just collapse the picker silently.
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

  // Recompute the mention context whenever the draft, caret, or thread cwd
  // changes. The slash menu wins so we don't double-open both surfaces.
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

  // Auto-resize the textarea up to ~10 visual rows of content; longer drafts
  // start scrolling internally so the composer doesn't push the chat
  // timeline off the screen. Runs in layoutEffect so the new height is in
  // place before paint (no visible jump).
  useLayoutEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    // Reset to the CSS-driven minimum (rows=3) before measuring scrollHeight,
    // otherwise shrinking is impossible — the element keeps its prior height.
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
    // Capture the textarea's current selection so `{selection}` works when
    // the user has highlighted a chunk of an in-progress draft. Empty when
    // the textarea is unfocused or has no selection (caret only).
    const ta = textareaRef.current;
    const selection = ta && ta.selectionStart !== ta.selectionEnd
      ? ta.value.slice(ta.selectionStart, ta.selectionEnd)
      : "";
    // Argv-style positional args feed `{1}`, `{2}`, … and `$ARGUMENTS`
    // placeholders in user-defined bodies. The raw arg string lives on
    // `slashState.rawArgs`; the parser handles quoted runs.
    const args = slashState ? parseSlashArgs(slashState.rawArgs) : [];
    const context = {
      threadId: selectedThreadId ?? "",
      threads: useThreadsStore.getState(),
      variables: {
        cwd: activeThread?.cwd,
        threadTitle: activeThread?.name ?? activeThread?.title,
        selection,
        args,
      },
    };
    // Custom commands expand into the draft so the user can review/edit before
    // sending — they're snippets, not actions. Built-ins clear the draft and
    // run their side effect.
    if (command.expand) {
      const body = command.expand(context);
      setDraft(body);
      setHistoryCursor(-1);
      draftBeforeRecallRef.current = "";
      setSlashCursor(0);
      // Push focus + caret to the end so users can keep typing immediately.
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

  // Cursor semantics: -1 = not recalling; 0 = most recent prompt; N-1 =
  // oldest prompt. Up (older) increments; Down (newer) decrements past 0
  // back to -1 which restores the in-progress draft we stashed on entry.
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
        // userPromptHistory is oldest-first; cursor 0 = most recent, so we
        // index from the end.
        setDraft(userPromptHistory[lastIndex - next]);
      }
      return next;
    });
  }

  function submit() {
    // Slash menu owns the draft when it's visible; the form's submit must
    // not strip the leading slash and ship the command name to the bridge.
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
    // Sent successfully — drop the persisted draft so the user doesn't see
    // their just-sent prompt re-hydrate when they come back later.
    if (selectedThreadId) {
      draftHydratedFromRef.current = "";
      void draftsStore.clear(selectedThreadId);
    }
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    submit();
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    // ⌘/Ctrl+Shift+F opens the composer's find/replace bar. Scoped to the
    // textarea so it only steals the chord while the user is typing here —
    // outside the composer the global ⌘/Ctrl+F still owns thread search.
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && (event.key === "f" || event.key === "F")) {
      event.preventDefault();
      setFindReplaceOpen(true);
      return;
    }
    // Mention picker wins over the rest when active — Enter inserts, ↑/↓
    // navigate, Esc dismisses without clearing the draft (unlike the slash
    // menu which clears the leading `/` token).
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
    // Slash menu wins over every other shortcut when it's visible — Enter
    // runs the highlighted command, ↑/↓ moves the cursor, Esc dismisses the
    // menu (without resetting any other state).
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
        // Tab autocompletes to the highlighted command's name so users can
        // see what they're about to run before committing with Enter.
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
    // Up-arrow recalls the most recent prompt only when the textarea has no
    // content (so it doesn't fight cursor navigation in a multi-line draft).
    // Down-arrow exits recall mode; both are no-ops if nothing's in history.
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
    // Manual edits drop us out of recall mode; from this point forward the
    // user is composing fresh, not browsing history.
    setDraft(value);
    if (historyCursor !== -1) {
      setHistoryCursor(-1);
      draftBeforeRecallRef.current = "";
    }
    // Re-detect the @-mention against the new draft + caret on the next
    // tick (selectionStart hasn't been updated synchronously by React's
    // change handler in some browsers).
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

  async function ingestFiles(files: FileList | File[] | null) {
    if (!files) return;
    const list = Array.from(files);
    if (list.length === 0) return;
    setAttachError(null);
    // Two ingest paths: image files become ImageAttachments (sent as
    // params.input image items), recognized text files get inlined into the
    // draft as fenced code blocks (no attachment surface needed — the prompt
    // is the carrier). Anything else is rejected with a friendly message so
    // we don't silently lose a drag.
    const imageAttachments: ImageAttachment[] = [];
    const textSnippets: string[] = [];
    for (const file of list) {
      const isImage = file.type.startsWith("image/");
      if (isImage) {
        try {
          imageAttachments.push(await attachmentFromFile(file));
        } catch (error) {
          setAttachError(error instanceof ImageAttachError ? error.message : (error as Error).message);
        }
        continue;
      }
      if (looksLikeTextFile(file)) {
        try {
          textSnippets.push((await attachmentFromTextFile(file)).fenced);
        } catch (error) {
          setAttachError(error instanceof TextAttachError ? error.message : (error as Error).message);
        }
        continue;
      }
      setAttachError(`Refusing \`${file.name || "file"}\` — only images and recognized text files are accepted.`);
    }
    if (imageAttachments.length > 0) setAttachments((current) => [...current, ...imageAttachments]);
    if (textSnippets.length > 0) {
      setDraft((current) => {
        const joined = textSnippets.join("\n\n");
        return current.trim() ? `${current.trimEnd()}\n\n${joined}` : joined;
      });
    }
  }

  function handlePaste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const items = event.clipboardData.items;
    const files: File[] = [];
    for (const item of items) {
      if (item.kind !== "file") continue;
      const file = item.getAsFile();
      if (!file) continue;
      // ingestFiles handles both image and text files; we accept anything
      // here so a paste of a `.ts` file from Finder/Files goes through the
      // same path drag/drop uses.
      if (file.type.startsWith("image/") || looksLikeTextFile(file)) files.push(file);
    }
    if (files.length > 0) {
      event.preventDefault();
      void ingestFiles(files);
    }
  }

  function removeAttachment(id: string) {
    setAttachments((current) => current.filter((entry) => entry.id !== id));
  }

  return (
    <form
      className={"agnt-composer" + (isDraggingFile ? " agnt-composer-drop" : "")}
      onSubmit={handleSubmit}
      onDragEnter={(event) => {
        if (event.dataTransfer.types.includes("Files")) setIsDraggingFile(true);
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) {
          event.preventDefault();
          setIsDraggingFile(true);
        }
      }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setIsDraggingFile(false);
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setIsDraggingFile(false);
        void ingestFiles(event.dataTransfer.files);
      }}
    >
      {attachments.length > 0 && (
        <div className="agnt-composer-attachments">
          {attachments.map((attachment) => (
            <div key={attachment.id} className="agnt-composer-attachment">
              <img src={attachment.thumbnailDataUrl} alt={attachment.fileName ?? "Attachment"} />
              <button
                type="button"
                className="agnt-composer-attachment-remove"
                onClick={() => removeAttachment(attachment.id)}
                aria-label="Remove attachment"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      {attachError && <div className="agnt-composer-attach-error">{attachError}</div>}
      {slashQuery !== null && slashMatches.length > 0 && (
        <div className="agnt-slash-menu" role="listbox" aria-label="Slash commands">
          {slashMatches.map((command, index) => {
            // Argument hint: introspect the body of user-defined commands
            // so the user can see "this expects 2 args" without clicking
            // through. Built-ins don't have bodies — the hint stays empty.
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
                  runSlashCommand(command);
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
      )}
      {slashQuery !== null && slashMatches.length === 0 && (
        <div className="agnt-slash-empty">No matching commands. Press Esc to dismiss or keep typing.</div>
      )}
      {mentionContext && mentionMatches.length > 0 && (
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
                applyMention(entry);
              }}
            >
              <code className="agnt-slash-item-name">{entry.name}</code>
              <span className="agnt-slash-item-description">{formatMentionPath(entry.path, mentionCwd ?? "")}</span>
            </button>
          ))}
        </div>
      )}
      {mentionContext && mentionMatches.length === 0 && !mentionLoading && (
        <div className="agnt-slash-empty">
          {mentionCwd
            ? "No files match — Esc to dismiss or keep typing."
            : "Pick a project (set the thread cwd) to search files."}
        </div>
      )}
      {mentionContext && mentionLoading && mentionMatches.length === 0 && (
        <div className="agnt-slash-empty">Searching files…</div>
      )}
      {findReplaceOpen && (
        <ComposerFindReplace
          textarea={textareaRef.current}
          draft={draft}
          onChange={(next) => onDraftChange(next)}
          onClose={() => setFindReplaceOpen(false)}
        />
      )}
      <div className={"agnt-composer-editor" + (previewOpen ? " agnt-composer-editor-split" : "")}>
        <textarea
          ref={textareaRef}
          id="agnt-composer-input"
          className="agnt-composer-input"
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={handleKeyDown}
          onKeyUp={handleCaretMove}
          onClick={handleCaretMove}
          onPaste={handlePaste}
          placeholder="Send a turn… (⌘/Ctrl+Enter; / for commands; @ to reference a file; paste or drop images and text files)"
          rows={3}
          spellCheck={false}
        />
        {previewOpen && (
          <div
            className="agnt-composer-preview"
            aria-label="Markdown preview"
            // Keep the preview scroll bounded to the same height as the
            // textarea so a long draft doesn't push the actions row off-screen.
            style={{ maxHeight: textareaRef.current?.clientHeight ?? 220 }}
          >
            {draft.trim() ? (
              <MarkdownContent text={draft} cwd={mentionCwd} />
            ) : (
              <span className="agnt-composer-preview-empty">Preview renders here while you type.</span>
            )}
          </div>
        )}
      </div>
      <input
        ref={fileInputRef}
        type="file"
        // Empty `accept` lets the picker show all files — looksLikeTextFile()
        // and the image MIME check filter at ingest time, where we can also
        // surface a friendly message for unsupported types.
        multiple
        hidden
        onChange={(event) => {
          void ingestFiles(event.target.files);
          if (fileInputRef.current) fileInputRef.current.value = "";
        }}
      />
      <DraftStatsFooter draft={draft} />
      <div className="agnt-composer-actions">
        <button
          type="button"
          className="agnt-button-ghost"
          onClick={() => fileInputRef.current?.click()}
          title="Attach images"
          aria-label="Attach images"
        >
          <Paperclip />
        </button>
        <VoiceButton />
        <PromptHistoryDropdown
          open={historyOpen}
          history={userPromptHistory}
          onOpenChange={setHistoryOpen}
          onPick={(text) => {
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
        />
        <button
          type="button"
          className={"agnt-button-ghost" + (previewOpen ? " agnt-button-ghost-active" : "")}
          onClick={() => setPreviewOpen((open) => !open)}
          title={previewOpen ? "Hide markdown preview" : "Show markdown preview"}
          aria-pressed={previewOpen}
          aria-label={previewOpen ? "Hide preview" : "Show preview"}
        >
          {previewOpen ? <EyeSlash /> : <Eye />}
        </button>
        {running ? (
          <button type="button" className="agnt-button-danger" onClick={onStop}>
            Stop
          </button>
        ) : (
          <button
            type="submit"
            className="agnt-button-primary"
            disabled={!draft.trim() && attachments.length === 0}
          >
            Send
          </button>
        )}
      </div>
    </form>
  );
}

// Reveals the active thread's past user prompts as a dropdown so users can
// pick one to drop into the draft without hunting for ↑-arrow recall mode.
// Closes on outside click, on Esc, and after any pick. Newest-first; long
// prompts are truncated for display only — picking still drops the full text.
function PromptHistoryDropdown({
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

  // Newest first; cap at 25 so the dropdown stays scannable on long threads.
  // Anything older is reachable via the existing ↑ arrow recall.
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

// Tiny footer beneath the textarea: char + word + approximate token counts.
// We surface the `~` on the token count so users know it's a heuristic and
// don't budget their context window against it for hard limits.
function DraftStatsFooter({ draft }: { draft: string }) {
  const stats = computeDraftStats(draft);
  if (stats.chars === 0) return null;
  return (
    <div className="agnt-composer-stats" aria-live="polite">
      {formatCount(stats.chars)} chars · {formatCount(stats.words)} {stats.words === 1 ? "word" : "words"} · ~{formatCount(stats.approxTokens)} tokens
    </div>
  );
}
