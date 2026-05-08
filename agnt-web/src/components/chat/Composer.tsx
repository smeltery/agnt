import { useEffect, useRef, useState } from "react";
import { attachmentFromFile, ImageAttachError } from "../../lib/image-attach";
import { attachmentFromTextFile, looksLikeTextFile, TextAttachError } from "../../lib/text-attach";
import type { ImageAttachment } from "../../models";
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
  }, [pendingTranscript, consumeTranscript]);

  function submit() {
    const text = draft.trim();
    if (!text && attachments.length === 0) return;
    if (running) return;
    onSend(text, attachments);
    setDraft("");
    setAttachments([]);
    setAttachError(null);
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    submit();
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
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
      <textarea
        id="agnt-composer-input"
        className="agnt-composer-input"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        placeholder="Send a turn… (⌘/Ctrl+Enter; paste or drop images and text files)"
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
