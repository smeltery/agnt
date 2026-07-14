import { useEffect, useRef } from "react";
import { useComposerInboxStore } from "../../state/composer-inbox-store";
import { useVoiceStore } from "../../state/voice-store";
import { draftsStore } from "../../storage/drafts-store";

const DRAFT_SAVE_DEBOUNCE_MS = 400;

type ComposerDraftLifecycleArgs = {
  draft: string;
  selectedThreadId: string | null;
  setDraft(next: string | ((current: string) => string)): void;
  resetHistory(): void;
};

export function useComposerDraftLifecycle({
  draft,
  selectedThreadId,
  setDraft,
  resetHistory,
}: ComposerDraftLifecycleArgs) {
  const previousThreadIdRef = useRef<string | null>(null);
  const draftHydratedFromRef = useRef<string>("");
  const pendingTranscript = useVoiceStore((state) => state.pendingTranscript);
  const consumeTranscript = useVoiceStore((state) => state.consumeTranscript);
  const inboxPending = useComposerInboxStore((state) => state.pending);

  useEffect(() => {
    if (!pendingTranscript) return;
    const transcript = consumeTranscript();
    if (!transcript) return;
    setDraft((current) => (current.trim() ? `${current.trimEnd()} ${transcript}` : transcript));
    resetHistory();
  }, [pendingTranscript, consumeTranscript, resetHistory, setDraft]);

  useEffect(() => {
    resetHistory();
    let cancelled = false;
    const previous = previousThreadIdRef.current;
    previousThreadIdRef.current = selectedThreadId;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedThreadId]);

  useEffect(() => {
    if (!selectedThreadId) return;
    if (draft === draftHydratedFromRef.current) return;
    const timeoutId = window.setTimeout(() => {
      void draftsStore.save(selectedThreadId, draft);
      draftHydratedFromRef.current = draft;
    }, DRAFT_SAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(timeoutId);
  }, [draft, selectedThreadId]);

  useEffect(() => {
    if (!selectedThreadId) return;
    const body = useComposerInboxStore.getState().consume(selectedThreadId);
    if (!body) return;
    setDraft((current) => (current.trim() ? `${body}${current}` : body));
    resetHistory();
  }, [inboxPending, selectedThreadId, resetHistory, setDraft]);

  useEffect(() => {
    if (!selectedThreadId) return;
    const handler = () => {
      void draftsStore.save(selectedThreadId, draft);
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [draft, selectedThreadId]);

  function clearPersistedDraft() {
    if (!selectedThreadId) return;
    draftHydratedFromRef.current = "";
    void draftsStore.clear(selectedThreadId);
  }

  return { clearPersistedDraft };
}
