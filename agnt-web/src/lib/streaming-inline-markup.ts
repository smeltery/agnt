interface InlineScanState {
  insideFence: boolean;
  insideCode: boolean;
  codeOpenerIndex: number;
  codeHasContent: boolean;
  insideBold: boolean;
  boldOpenerIndex: number;
  boldHasContent: boolean;
}

export function autoCloseStreamingInlineMarkup(text: string): string {
  if (!text) return text;

  const state: InlineScanState = {
    insideFence: false,
    insideCode: false,
    codeOpenerIndex: 0,
    codeHasContent: false,
    insideBold: false,
    boldOpenerIndex: 0,
    boldHasContent: false,
  };

  let lineStart = 0;
  while (lineStart < text.length) {
    const newlineIndex = text.indexOf("\n", lineStart);
    const lineEnd = newlineIndex === -1 ? text.length : newlineIndex;
    const line = text.slice(lineStart, lineEnd);
    const trimmed = line.trim();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      state.insideFence = !state.insideFence;
    } else if (!state.insideFence) {
      scanInlineLine(text, lineStart, lineEnd, lineEnd === text.length, state);
    }
    lineStart = newlineIndex === -1 ? text.length : newlineIndex + 1;
  }

  if (state.insideFence || (!state.insideCode && !state.insideBold)) return text;

  if (state.insideBold && !state.boldHasContent) return text.slice(0, state.boldOpenerIndex);
  if (state.insideCode && !state.codeHasContent) {
    let held = text.slice(0, state.codeOpenerIndex);
    if (state.insideBold) held = trimTrailingWhitespace(held) + "**";
    return held;
  }

  let closed = text;
  if (state.insideCode) closed += "`";
  if (state.insideBold) {
    if (!state.insideCode) closed = trimTrailingWhitespace(closed);
    closed += "**";
  }
  return closed;
}

function scanInlineLine(
  text: string,
  lineStart: number,
  lineEnd: number,
  isLastLine: boolean,
  state: InlineScanState
): void {
  let index = lineStart;
  while (index < lineEnd) {
    const char = text[index];

    if (char === "\\") {
      index += 1;
      if (index < lineEnd) index += 1;
      if (state.insideCode) state.codeHasContent = true;
      if (state.insideBold) state.boldHasContent = true;
      continue;
    }

    if (char === "`") {
      if (state.insideCode) {
        state.insideCode = false;
        if (state.insideBold) state.boldHasContent = true;
      } else {
        state.insideCode = true;
        state.codeOpenerIndex = index;
        state.codeHasContent = false;
      }
      index += 1;
      continue;
    }

    if (char === "*" && !state.insideCode && text[index + 1] === "*") {
      const afterMarker = index + 2;
      if (state.insideBold) {
        state.insideBold = false;
        state.boldHasContent = false;
      } else if (afterMarker < lineEnd && !isWhitespace(text[afterMarker])) {
        state.insideBold = true;
        state.boldOpenerIndex = index;
        state.boldHasContent = false;
      } else if (afterMarker === lineEnd && isLastLine) {
        state.insideBold = true;
        state.boldOpenerIndex = index;
        state.boldHasContent = false;
      }
      index = afterMarker;
      continue;
    }

    if (!isWhitespace(char)) {
      if (state.insideCode) state.codeHasContent = true;
      if (state.insideBold) state.boldHasContent = true;
    }
    index += 1;
  }
}

function isWhitespace(char: string | undefined): boolean {
  return char === undefined || /\s/.test(char);
}

function trimTrailingWhitespace(text: string): string {
  return text.replace(/\s+$/u, "");
}
