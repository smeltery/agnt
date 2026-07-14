import { useState, type Dispatch, type SetStateAction } from "react";
import { attachmentFromFile, ImageAttachError } from "../../lib/image-attach";
import { attachmentFromTextFile, looksLikeTextFile, TextAttachError } from "../../lib/text-attach";
import type { ImageAttachment } from "../../models";

export function useComposerAttachments(setDraft: Dispatch<SetStateAction<string>>) {
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);

  function reorderAttachments(sourceId: string, targetId: string) {
    setAttachments((current) => {
      const from = current.findIndex((entry) => entry.id === sourceId);
      const to = current.findIndex((entry) => entry.id === targetId);
      if (from < 0 || to < 0 || from === to) return current;
      const next = current.slice();
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }

  async function ingestFiles(files: FileList | File[] | null) {
    if (!files) return;
    const list = Array.from(files);
    if (list.length === 0) return;
    setAttachError(null);
    const imageAttachments: ImageAttachment[] = [];
    const textSnippets: string[] = [];
    for (const file of list) {
      if (file.type.startsWith("image/")) {
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

  function removeAttachment(id: string) {
    setAttachments((current) => current.filter((entry) => entry.id !== id));
  }

  return {
    attachError,
    attachments,
    ingestFiles,
    removeAttachment,
    reorderAttachments,
    setAttachError,
    setAttachments,
  };
}
