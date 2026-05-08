// Tiny ephemeral store for the image lightbox. The chat row clicks an image
// → store stamps it → workspace renders the overlay. Keeping it in zustand
// (vs prop-drilling through ChatView) means a future feature like clicking
// the assistant's referenced workspace image can drop in without touching
// every component.

import { create } from "zustand";

export interface LightboxImage {
  src: string;
  alt?: string;
  caption?: string;
}

interface State {
  current: LightboxImage | null;
  show(image: LightboxImage): void;
  hide(): void;
}

export const useLightboxStore = create<State>((set) => ({
  current: null,
  show(image) {
    set({ current: image });
  },
  hide() {
    set({ current: null });
  },
}));
