// Hand-traced SVG icons that approximate the SF Symbols agnt uses on iOS.
// We deliberately don't ship the proprietary SF Symbols font — these are
// our own minimal renders, sized to a 16px viewBox so they sit naturally in
// chrome targets. Every icon inherits color from the surrounding text via
// `currentColor`, so dark/light theme + provider tints just work.
//
// Adding a new icon: keep the viewBox at 16×16, prefer `stroke` for outline
// glyphs and `fill` for solid ones, and reuse `BASE_STROKE_PROPS` so the
// entire set has consistent line weight + cap/join behavior.

import type { CSSProperties, SVGProps } from "react";

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "xmlns" | "viewBox" | "fill" | "stroke"> {
  size?: number;
  className?: string;
  style?: CSSProperties;
}

const BASE_STROKE_PROPS = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function svgProps({ size = 16, className, style, ...rest }: IconProps) {
  return {
    width: size,
    height: size,
    viewBox: "0 0 16 16",
    xmlns: "http://www.w3.org/2000/svg",
    className,
    style,
    "aria-hidden": rest["aria-label"] ? undefined : true,
    ...rest,
  };
}

export function ChevronRight(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path {...BASE_STROKE_PROPS} d="M6 4 L10 8 L6 12" />
    </svg>
  );
}

export function ChevronLeft(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path {...BASE_STROKE_PROPS} d="M10 4 L6 8 L10 12" />
    </svg>
  );
}

export function ChevronDown(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path {...BASE_STROKE_PROPS} d="M4 6 L8 10 L12 6" />
    </svg>
  );
}

export function ChevronUp(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path {...BASE_STROKE_PROPS} d="M4 10 L8 6 L12 10" />
    </svg>
  );
}

export function Cloud(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path
        {...BASE_STROKE_PROPS}
        d="M5.4 12.5 H12 A2.5 2.5 0 0 0 12.2 7.5 A4 4 0 0 0 4.7 6.4 A3.1 3.1 0 0 0 5.4 12.5 Z"
      />
    </svg>
  );
}

export function Xmark(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path {...BASE_STROKE_PROPS} d="M4 4 L12 12 M12 4 L4 12" />
    </svg>
  );
}

export function Ellipsis(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <circle cx="3.5" cy="8" r="1.1" fill="currentColor" />
      <circle cx="8" cy="8" r="1.1" fill="currentColor" />
      <circle cx="12.5" cy="8" r="1.1" fill="currentColor" />
    </svg>
  );
}

export function MagnifyingGlass(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <circle {...BASE_STROKE_PROPS} cx="7" cy="7" r="4.25" />
      <path {...BASE_STROKE_PROPS} d="M10.2 10.2 L13.5 13.5" />
    </svg>
  );
}

export function Plus(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path {...BASE_STROKE_PROPS} d="M8 3 L8 13 M3 8 L13 8" />
    </svg>
  );
}

export function ArrowDown(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path {...BASE_STROKE_PROPS} d="M8 3 L8 13 M4 9 L8 13 L12 9" />
    </svg>
  );
}

export function ArrowClockwise(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      {/* Three-quarter arc with an arrowhead so it reads as "refresh". */}
      <path
        {...BASE_STROKE_PROPS}
        d="M12.5 4.5 A5 5 0 1 0 13 9.5"
      />
      <path {...BASE_STROKE_PROPS} d="M12.5 2 L12.5 5 L9.5 5" />
    </svg>
  );
}

export function ArrowUturnLeft(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      {/* "Revert" arrow: hooked back to the left. */}
      <path {...BASE_STROKE_PROPS} d="M3.5 7 L7 3.5 L7 5 L11 5 A2.5 2.5 0 0 1 11 11 L9 11" />
      <path {...BASE_STROKE_PROPS} d="M6 3.5 L7 4.5 M3.5 7 L4.5 8" />
    </svg>
  );
}

export function ArrowshapeTurnUpLeft(props: IconProps) {
  // SF Symbols' chunky reply arrow.
  return (
    <svg {...svgProps(props)}>
      <path
        {...BASE_STROKE_PROPS}
        d="M6 5 L2.5 8 L6 11 L6 9 L10.5 9 A1.5 1.5 0 0 1 12 10.5 L12 12.5 L13.5 12 L13.5 9 A3 3 0 0 0 10.5 6 L6 6 Z"
      />
    </svg>
  );
}

export function Clock(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <circle {...BASE_STROKE_PROPS} cx="8" cy="8" r="5.5" />
      <path {...BASE_STROKE_PROPS} d="M8 4.5 L8 8 L10.5 9.5" />
    </svg>
  );
}

export function ClockArrowCirclepath(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      {/* Clock face plus a small circular arrow above-right hinting at history. */}
      <circle {...BASE_STROKE_PROPS} cx="8" cy="8" r="5.5" />
      <path {...BASE_STROKE_PROPS} d="M8 5 L8 8 L10 9.5" />
      <path {...BASE_STROKE_PROPS} d="M12.5 3.5 A3 3 0 1 0 13 6.5" />
      <path {...BASE_STROKE_PROPS} d="M12.5 1.5 L12.5 4 L10 4" />
    </svg>
  );
}

export function Eye(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path {...BASE_STROKE_PROPS} d="M1.5 8 C3 4.5 5 3 8 3 C11 3 13 4.5 14.5 8 C13 11.5 11 13 8 13 C5 13 3 11.5 1.5 8 Z" />
      <circle {...BASE_STROKE_PROPS} cx="8" cy="8" r="1.75" />
    </svg>
  );
}

export function EyeSlash(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path {...BASE_STROKE_PROPS} d="M1.5 8 C3 4.5 5 3 8 3 C11 3 13 4.5 14.5 8 C13 11.5 11 13 8 13 C5 13 3 11.5 1.5 8 Z" />
      <circle {...BASE_STROKE_PROPS} cx="8" cy="8" r="1.75" />
      <path {...BASE_STROKE_PROPS} d="M2 14 L14 2" />
    </svg>
  );
}

export function Star(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path
        {...BASE_STROKE_PROPS}
        d="M8 2 L9.85 5.85 L14 6.4 L11 9.4 L11.7 13.5 L8 11.5 L4.3 13.5 L5 9.4 L2 6.4 L6.15 5.85 Z"
      />
    </svg>
  );
}

export function StarFill(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path
        fill="currentColor"
        d="M8 2 L9.85 5.85 L14 6.4 L11 9.4 L11.7 13.5 L8 11.5 L4.3 13.5 L5 9.4 L2 6.4 L6.15 5.85 Z"
      />
    </svg>
  );
}

export function PinFill(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path
        fill="currentColor"
        d="M9.5 1.5 L13.5 5.5 L11.5 6.5 L11 9 L9 7 L4.5 11.5 L3 13 L4.5 11.5 L9 7 L7 5 L9.5 4.5 Z"
      />
    </svg>
  );
}

export function Link(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      {/* Two interlinked capsules at 45°. */}
      <path
        {...BASE_STROKE_PROPS}
        d="M6.5 9.5 A2.5 2.5 0 0 1 6.5 6 L8 4.5 A2.5 2.5 0 1 1 11.5 8 L10.5 9"
      />
      <path
        {...BASE_STROKE_PROPS}
        d="M9.5 6.5 A2.5 2.5 0 0 1 9.5 10 L8 11.5 A2.5 2.5 0 1 1 4.5 8 L5.5 7"
      />
    </svg>
  );
}

export function Paperclip(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path
        {...BASE_STROKE_PROPS}
        d="M11.5 7 L6.5 12 A2.5 2.5 0 0 1 3 8.5 L9 2.5 A3.5 3.5 0 0 1 14 7.5 L8.5 13"
      />
    </svg>
  );
}

export function Mic(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      {/* Capsule body 6→10 wide, 2→9 tall, plus the stand U. */}
      <rect {...BASE_STROKE_PROPS} x="6" y="2" width="4" height="7" rx="2" />
      <path {...BASE_STROKE_PROPS} d="M3.5 8 A4.5 4.5 0 0 0 12.5 8" />
      <path {...BASE_STROKE_PROPS} d="M8 12.5 L8 14" />
    </svg>
  );
}

export function Line3Horizontal(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path {...BASE_STROKE_PROPS} d="M3 5 L13 5 M3 8 L13 8 M3 11 L13 11" />
    </svg>
  );
}

export function Line3HorizontalDecrease(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path {...BASE_STROKE_PROPS} d="M3 5 L13 5 M5 8 L13 8 M7 11 L13 11" />
    </svg>
  );
}

export function Trash(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path {...BASE_STROKE_PROPS} d="M3.5 4.5 L12.5 4.5" />
      <path {...BASE_STROKE_PROPS} d="M6 4.5 V3 A1 1 0 0 1 7 2 H9 A1 1 0 0 1 10 3 V4.5" />
      <path {...BASE_STROKE_PROPS} d="M5 4.5 L5.75 13 A1 1 0 0 0 6.75 14 H9.25 A1 1 0 0 0 10.25 13 L11 4.5" />
      <path {...BASE_STROKE_PROPS} d="M7 7 L7 12 M9 7 L9 12" />
    </svg>
  );
}

/** Map of all exported icons. Useful for tests + the icon-gallery surface
 *  that future sessions can drop into the help overlay if we want a
 *  reference card. */
export const ALL_ICONS = {
  ArrowClockwise,
  ArrowDown,
  ArrowshapeTurnUpLeft,
  ArrowUturnLeft,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Clock,
  ClockArrowCirclepath,
  Ellipsis,
  Eye,
  EyeSlash,
  Line3Horizontal,
  Line3HorizontalDecrease,
  Link,
  MagnifyingGlass,
  Mic,
  Paperclip,
  PinFill,
  Plus,
  Star,
  StarFill,
  Trash,
  Xmark,
} as const;
