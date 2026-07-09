import { useEffect, useMemo, useState } from "react";
import type { PetManifest } from "./pet-manifest";

type PetProps = {
  manifest: PetManifest;
  basePath: string;
  appState: string;
  scale?: number;
  animationOverride?: string;
  mirrorX?: boolean;
};

export function PetSprite({ manifest, basePath, appState, scale = 1, animationOverride, mirrorX }: PetProps) {
  const animationName = animationOverride
    ?? manifest.stateMap[appState]
    ?? manifest.stateMap.default
    ?? "idle";
  const animation =
    manifest.animations[animationName] ?? manifest.animations.idle;

  const [frame, setFrame] = useState(0);

  useEffect(() => {
    queueMicrotask(() => setFrame(0));
    if (animation.frames <= 1) return;

    const frameMs = 1000 / animation.fps;
    const id = window.setInterval(() => {
      setFrame((prev) => {
        const next = prev + 1;
        if (next < animation.frames) return next;
        return animation.loop ? 0 : animation.frames - 1;
      });
    }, frameMs);

    return () => window.clearInterval(id);
  }, [animationName, animation.fps, animation.frames, animation.loop]);

  const cellW = manifest.spritesheet.cellWidth;
  const cellH = manifest.spritesheet.cellHeight;
  const cols = manifest.spritesheet.columns;

  const backgroundPosition = useMemo(() => {
    const xPx = -(frame * cellW * scale);
    const yPx = -(animation.row * cellH * scale);
    return `${xPx}px ${yPx}px`;
  }, [frame, animation.row, cellW, cellH, scale]);

  const bgWidth = cols * cellW * scale;

  return (
    <div
      aria-label={`${manifest.name} pet: ${animationName}`}
      style={{
        width: cellW * scale,
        height: cellH * scale,
        transform: mirrorX ? "scaleX(-1)" : undefined,
        transformOrigin: "center center",
        backgroundImage: `url("${basePath}/${manifest.spritesheet.file}")`,
        backgroundRepeat: "no-repeat",
        backgroundPosition,
        backgroundSize: `${bgWidth}px auto`,
        imageRendering: "pixelated",
        pointerEvents: "none",
      }}
    />
  );
}
