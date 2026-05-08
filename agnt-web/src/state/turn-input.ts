// Builds the `params.input` array that bridge translators expect for
// turn/start. Mirrors AgntMobile's makeTurnInputPayload — image items first
// (so the assistant's first context is visual), then a single text item
// holding the typed prompt. The bridge's image url field is `url` (or
// `image_url` on Codex pre-experimentalApi); we always send `url` because
// every modern translator reads that key.

import type { ImageAttachment } from "../models";

export interface TurnInputItem {
  type: "text" | "image";
  text?: string;
  url?: string;
}

export function buildTurnInput(text: string, attachments: ImageAttachment[] | undefined): TurnInputItem[] {
  const items: TurnInputItem[] = [];
  if (attachments) {
    for (const attachment of attachments) {
      const data = attachment.payloadDataUrl?.trim();
      if (!data) continue;
      items.push({ type: "image", url: data });
    }
  }
  const trimmed = text.trim();
  if (trimmed) items.push({ type: "text", text: trimmed });
  return items;
}
