import type React from "react";
import type { MentionContext } from "../../lib/mention-detector";
import type { ImageAttachment } from "../../models";
import type { ProjectDirectoryEntry } from "../../protocol/project";
import type { SlashCommand } from "../../state/slash-commands";
import { Eye, EyeSlash, Paperclip } from "../shared/Icon";
import { ComposerFindReplace } from "./ComposerFindReplace";
import { ComposerMentionMenu, ComposerSlashMenu, DraftStatsFooter, PromptHistoryDropdown } from "./ComposerPickers";
import { MarkdownContent } from "./MarkdownContent";
import { ThreadGoalControl } from "./ThreadGoalControl";
import { VoiceButton } from "./VoiceButton";

export type CustomSlashCommandShape = {
  name: string;
  body: string;
};

export type ComposerSurfaceProps = {
  activeThreadId: string | null;
  attachError: string | null;
  attachments: ImageAttachment[];
  customSlashCommands: CustomSlashCommandShape[];
  draft: string;
  dragSourceId: string | null;
  dropTargetId: string | null;
  expandedOpen: boolean;
  expandedTextareaRef: React.RefObject<HTMLTextAreaElement | null>;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  findReplaceOpen: boolean;
  history: string[];
  historyOpen: boolean;
  isDraggingFile: boolean;
  mentionContext: MentionContext | null;
  mentionCursor: number;
  mentionCwd: string | undefined;
  mentionLoading: boolean;
  mentionMatches: ProjectDirectoryEntry[];
  previewOpen: boolean;
  running: boolean;
  slashCursor: number;
  slashMatches: SlashCommand[];
  slashQuery: string | null;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  onApplyMention(entry: ProjectDirectoryEntry): void;
  onAttachInputChange(files: FileList | null): void;
  onCaretMove(event: React.SyntheticEvent<HTMLTextAreaElement>): void;
  onCloseExpanded(): void;
  onCloseFindReplace(): void;
  onDraftChange(value: string): void;
  onDragFileChange(isDragging: boolean): void;
  onDragSourceChange(id: string | null): void;
  onDropFiles(files: FileList): void;
  onDropTargetChange(id: string | null): void;
  onExpandedOpenChange(open: boolean): void;
  onHistoryOpenChange(open: boolean): void;
  onHistoryPick(text: string): void;
  onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>): void;
  onPaste(event: React.ClipboardEvent<HTMLTextAreaElement>): void;
  onPreviewOpenChange(open: boolean): void;
  onRemoveAttachment(id: string): void;
  onReorderAttachments(sourceId: string, targetId: string): void;
  onRunSlashCommand(command: SlashCommand): void;
  onSendExpanded(): void;
  onStop(): void;
  onSubmit(event: React.FormEvent): void;
};

export function ComposerSurface(props: ComposerSurfaceProps) {
  const { attachError, expandedOpen, findReplaceOpen, isDraggingFile, textareaRef } = props;
  return (
    <form
      className={"agnt-composer" + (isDraggingFile ? " agnt-composer-drop" : "")}
      onSubmit={props.onSubmit}
      onDragEnter={(event) => {
        if (event.dataTransfer.types.includes("Files")) props.onDragFileChange(true);
      }}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        props.onDragFileChange(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) props.onDragFileChange(false);
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        props.onDragFileChange(false);
        props.onDropFiles(event.dataTransfer.files);
      }}
    >
      <ComposerAttachments {...props} />
      {attachError && <div className="agnt-composer-attach-error">{attachError}</div>}
      <ComposerSlashMenu {...props} />
      <ComposerMentionMenu {...props} />
      {findReplaceOpen && (
        <ComposerFindReplace
          textarea={textareaRef.current}
          draft={props.draft}
          onChange={props.onDraftChange}
          onClose={props.onCloseFindReplace}
        />
      )}
      <ComposerEditor {...props} />
      <input
        ref={props.fileInputRef}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          props.onAttachInputChange(event.target.files);
          if (props.fileInputRef.current) props.fileInputRef.current.value = "";
        }}
      />
      <DraftStatsFooter draft={props.draft} />
      <ComposerActions {...props} />
      {expandedOpen && <ComposerExpandedEditor {...props} />}
    </form>
  );
}

function ComposerAttachments({
  attachments,
  dragSourceId,
  dropTargetId,
  onDragSourceChange,
  onDropTargetChange,
  onRemoveAttachment,
  onReorderAttachments,
}: ComposerSurfaceProps) {
  if (attachments.length === 0) return null;
  return (
    <div className="agnt-composer-attachments">
      {attachments.map((attachment) => (
        <div
          key={attachment.id}
          className={
            "agnt-composer-attachment"
            + (dragSourceId === attachment.id ? " agnt-composer-attachment-dragging" : "")
            + (dropTargetId === attachment.id && dragSourceId !== attachment.id
              ? " agnt-composer-attachment-droptarget"
              : "")
          }
          draggable={attachments.length > 1}
          onDragStart={() => onDragSourceChange(attachment.id)}
          onDragEnd={() => {
            onDragSourceChange(null);
            onDropTargetChange(null);
          }}
          onDragEnter={(event) => {
            if (!dragSourceId) return;
            event.preventDefault();
            if (dropTargetId !== attachment.id) onDropTargetChange(attachment.id);
          }}
          onDragOver={(event) => {
            if (dragSourceId) event.preventDefault();
          }}
          onDrop={(event) => {
            if (!dragSourceId || dragSourceId === attachment.id) return;
            event.preventDefault();
            onReorderAttachments(dragSourceId, attachment.id);
            onDragSourceChange(null);
            onDropTargetChange(null);
          }}
          title={attachments.length > 1 ? "Drag to reorder" : undefined}
        >
          <img src={attachment.thumbnailDataUrl} alt={attachment.fileName ?? "Attachment"} />
          <button
            type="button"
            className="agnt-composer-attachment-remove"
            onClick={() => onRemoveAttachment(attachment.id)}
            aria-label="Remove attachment"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

function ComposerEditor({
  draft,
  mentionCwd,
  previewOpen,
  textareaRef,
  onCaretMove,
  onDraftChange,
  onKeyDown,
  onPaste,
}: ComposerSurfaceProps) {
  return (
    <div className={"agnt-composer-editor" + (previewOpen ? " agnt-composer-editor-split" : "")}>
      <textarea
        ref={textareaRef}
        id="agnt-composer-input"
        className="agnt-composer-input"
        value={draft}
        onChange={(event) => onDraftChange(event.target.value)}
        onKeyDown={onKeyDown}
        onKeyUp={onCaretMove}
        onClick={onCaretMove}
        onPaste={onPaste}
        placeholder="Send a turn... (Cmd/Ctrl+Enter; / for commands; @ to reference a file; paste or drop images and text files)"
        rows={3}
        spellCheck={false}
      />
      {previewOpen && (
        <div className="agnt-composer-preview" aria-label="Markdown preview" style={{ maxHeight: textareaRef.current?.clientHeight ?? 220 }}>
          {draft.trim() ? (
            <MarkdownContent text={draft} cwd={mentionCwd} />
          ) : (
            <span className="agnt-composer-preview-empty">Preview renders here while you type.</span>
          )}
        </div>
      )}
    </div>
  );
}

function ComposerActions(props: ComposerSurfaceProps) {
  return (
    <div className="agnt-composer-actions">
      <button
        type="button"
        className="agnt-button-ghost"
        onClick={() => props.fileInputRef.current?.click()}
        title="Attach images"
        aria-label="Attach images"
      >
        <Paperclip />
      </button>
      <VoiceButton />
      <ThreadGoalControl threadId={props.activeThreadId} />
      <PromptHistoryDropdown
        open={props.historyOpen}
        history={props.history}
        onOpenChange={props.onHistoryOpenChange}
        onPick={props.onHistoryPick}
      />
      <button
        type="button"
        className={"agnt-button-ghost" + (props.previewOpen ? " agnt-button-ghost-active" : "")}
        onClick={() => props.onPreviewOpenChange(!props.previewOpen)}
        title={props.previewOpen ? "Hide markdown preview" : "Show markdown preview"}
        aria-pressed={props.previewOpen}
        aria-label={props.previewOpen ? "Hide preview" : "Show preview"}
      >
        {props.previewOpen ? <EyeSlash /> : <Eye />}
      </button>
      <button
        type="button"
        className="agnt-button-ghost"
        onClick={() => props.onExpandedOpenChange(true)}
        title="Expand to a viewport-tall editor (Esc to close)"
        aria-label="Expand composer"
      >
        ⤢
      </button>
      {props.running ? (
        <button type="button" className="agnt-button-danger" onClick={props.onStop}>
          Stop
        </button>
      ) : (
        <button type="submit" className="agnt-button-primary" disabled={!props.draft.trim() && props.attachments.length === 0}>
          Send
        </button>
      )}
    </div>
  );
}

function ComposerExpandedEditor({ draft, expandedTextareaRef, onCloseExpanded, onDraftChange, onSendExpanded }: ComposerSurfaceProps) {
  return (
    <div
      className="agnt-composer-expanded-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Expanded composer"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCloseExpanded();
      }}
    >
      <div className="agnt-composer-expanded">
        <header className="agnt-composer-expanded-header">
          <span>Expanded composer · Esc to close</span>
          <button type="button" className="agnt-button-ghost" onClick={onCloseExpanded} aria-label="Close expanded composer">
            Close
          </button>
        </header>
        <textarea
          ref={expandedTextareaRef}
          className="agnt-composer-expanded-input"
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || (!event.metaKey && !event.ctrlKey)) return;
            event.preventDefault();
            onSendExpanded();
          }}
          placeholder="Drafting a long prompt…"
          spellCheck={false}
        />
      </div>
    </div>
  );
}
