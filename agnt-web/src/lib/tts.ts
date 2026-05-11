// Read-aloud via the browser's Web Speech SpeechSynthesis API. No external
// dependency, no server round-trip; the voice quality is whatever the
// platform provides (macOS / iOS get the highest-fidelity options on
// average). We keep the surface tiny:
//
//   speak(text)       – cancel any in-flight utterance, queue this one
//   stop()            – cancel anything currently speaking
//   isSpeaking()      – snapshot for UI state
//
// We strip code fences from the text before speaking — TTS reading every
// brace and dash from a 40-line snippet is hostile, not helpful. The
// reader hears the prose and a "code block" stub instead.

const CODE_FENCE = /```[a-zA-Z0-9-]*\n[\s\S]*?\n```/g;
const INLINE_CODE = /`([^`\n]+)`/g;
const MARKDOWN_BOLD = /\*\*([^*\n]+)\*\*/g;
const MARKDOWN_ITALIC = /(?<!\*)\*([^*\n]+)\*(?!\*)/g;
const MD_LINK = /\[([^\]]+)\]\([^)]+\)/g;

export function isTtsSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

/** Strip markdown markup so the TTS reads "this is bold" instead of
 *  "asterisk asterisk this is bold asterisk asterisk". Code fences
 *  collapse to a literal "code block" so the reader knows to look
 *  rather than listen. */
export function prepareTextForSpeech(text: string): string {
  return text
    .replace(CODE_FENCE, "[code block]")
    .replace(INLINE_CODE, "$1")
    .replace(MARKDOWN_BOLD, "$1")
    .replace(MARKDOWN_ITALIC, "$1")
    .replace(MD_LINK, "$1")
    // Collapse any runs of whitespace introduced by the substitutions
    // above so the cadence doesn't gain awkward silences.
    .replace(/\s+/g, " ")
    .trim();
}

export function speak(text: string): void {
  if (!isTtsSupported()) return;
  const synth = window.speechSynthesis;
  // SpeechSynthesisUtterance has a max length on some platforms (~32 KB);
  // long assistant messages get a hard cap so the platform doesn't drop
  // the request silently. The cap is generous enough that any normal
  // chat message fits whole.
  const trimmed = prepareTextForSpeech(text).slice(0, 16_000);
  if (!trimmed) return;
  synth.cancel();
  const utterance = new SpeechSynthesisUtterance(trimmed);
  // Slightly slower than default for clarity over a long chat message —
  // the platform default tends to be a little fast for technical prose.
  utterance.rate = 0.95;
  synth.speak(utterance);
}

export function stop(): void {
  if (!isTtsSupported()) return;
  window.speechSynthesis.cancel();
}

export function isSpeaking(): boolean {
  if (!isTtsSupported()) return false;
  return window.speechSynthesis.speaking || window.speechSynthesis.pending;
}
