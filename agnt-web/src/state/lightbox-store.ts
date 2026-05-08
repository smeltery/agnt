// Tiny ephemeral store for the image lightbox. The chat row can stamp either
// a single image (lightbox is closeable but not navigable) or a set of
// siblings + the active index (left/right arrow keys cycle within the set).
//
// Keeping it in zustand vs prop-drilling means a future feature like
// clicking the assistant's referenced workspace image can drop in without
// touching every component.

import { create } from "zustand";

export interface LightboxImage {
  src: string;
  alt?: string;
  caption?: string;
}

interface LightboxState {
  /** Ordered list of images currently in scope (the row's full attachment set, etc.). */
  images: LightboxImage[];
  /** Index into `images` of the currently displayed one. -1 when not open. */
  index: number;
  show(images: LightboxImage[], index: number): void;
  showOne(image: LightboxImage): void;
  step(direction: -1 | 1): void;
  hide(): void;
}

export const useLightboxStore = create<LightboxState>((set, get) => ({
  images: [],
  index: -1,
  show(images, index) {
    if (images.length === 0) return;
    const clamped = Math.max(0, Math.min(index, images.length - 1));
    set({ images, index: clamped });
  },
  showOne(image) {
    set({ images: [image], index: 0 });
  },
  step(direction) {
    const { images, index } = get();
    if (images.length === 0 || index < 0) return;
    const next = (index + direction + images.length) % images.length;
    if (next === index) return;
    set({ index: next });
  },
  hide() {
    set({ images: [], index: -1 });
  },
}));

export function selectCurrentImage(state: LightboxState): LightboxImage | null {
  if (state.index < 0) return null;
  return state.images[state.index] ?? null;
}
