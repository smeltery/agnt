import { useEffect, useMemo, useRef, useState } from "react";
import { attachmentFromFile, ImageAttachError } from "../../lib/image-attach";
import { attachmentFromTextFile, looksLikeTextFile, TextAttachError } from "../../lib/text-attach";
import type { ImageAttachment } from "../../models";
import { filterSlashCommands, type SlashCommand } from "../../state/slash-commands";
import { selectActiveMessages, useThreadsStore } from "../../state/threads-store";
import { useVoiceStore } from "../../state/voice-store";
import { VoiceButton } from "./VoiceButton";

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
  const fileInputRef = useRef<HTMLInputElement>(null);
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
  // prompts from another thread shouldn't paste into this one.
  const selectedThreadId = useThreadsStore((state) => state.selectedThreadId);
  useEffect(() => {
    setHistoryCursor(-1);
    draftBeforeRecallRef.current = "";
  }, [selectedThreadId]);

  // Slash-menu surface. Matches when the draft starts with "/" and contains
  // no whitespace yet — that's the typing window we own. Once the user adds
  // a space the draft is just a normal prompt that happens to start with a
  // slash, which we intentionally do NOT intercept.
  const slashQuery = useMemo(() => {
    if (!draft.startsWith("/")) return null;
    if (/\s/.test(draft)) return null;
    return draft.slice(1);
  }, [draft]);
  // We need the snapshot at run-time, not on every render; subscribing the
  // whole component to threads-store would re-render on every streaming
  // delta. Instead grab the snapshot lazily inside the action handler.
  const slashMatches = useMemo(() => {
    if (slashQuery === null) return [];
    return filterSlashCommands(slashQuery, {
      threadId: selectedThreadId ?? "",
      threads: useThreadsStore.getState(),
    });
    // The match list only depends on the typed query + which thread is
    // selected. canRun() is queried again at run time so a thread switch
    // mid-typing still picks the right command.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slashQuery, selectedThreadId]);
  const [slashCursor, setSlashCursor] = useState(0);
  // Reset the highlight cursor any time the visible match list changes.
  useEffect(() => {
    setSlashCursor(0);
  }, [slashMatches.length]);

  function runSlashCommand(command: SlashCommand) {
    setDraft("");
    setHistoryCursor(-1);
    draftBeforeRecallRef.current = "";
    setSlashCursor(0);
    void command.run({ threadId: selectedThreadId ?? "", threads: useThreadsStore.getState() });
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
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    submit();
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
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
          {slashMatches.map((command, index) => (
            <button
              key={command.name}
              type="button"
              role="option"
              aria-selected={index === slashCursor}
              className={"agnt-slash-item" + (index === slashCursor ? " agnt-slash-item-active" : "")}
              // onMouseDown beats the textarea's onBlur — clicking should run
              // the command, not steal focus mid-cycle.
              onMouseDown={(event) => {
                event.preventDefault();
                runSlashCommand(command);
              }}
            >
              <code className="agnt-slash-item-name">/{command.name}</code>
              <span className="agnt-slash-item-description">{command.description}</span>
            </button>
          ))}
        </div>
      )}
      {slashQuery !== null && slashMatches.length === 0 && (
        <div className="agnt-slash-empty">No matching commands. Press Esc to dismiss or keep typing.</div>
      )}
      <textarea
        id="agnt-composer-input"
        className="agnt-composer-input"
        value={draft}
        onChange={(event) => onDraftChange(event.target.value)}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        placeholder="Send a turn… (⌘/Ctrl+Enter; / for commands; paste or drop images and text files)"
        rows={3}
        spellCheck={false}
      />
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
      <div className="agnt-composer-actions">
        <button
          type="button"
          className="agnt-button-ghost"
          onClick={() => fileInputRef.current?.click()}
          title="Attach images"
        >
          📎
        </button>
        <VoiceButton />
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
