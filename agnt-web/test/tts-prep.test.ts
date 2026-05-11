// `prepareTextForSpeech`: strips markdown markup + code so TTS reads
// the prose, not the syntax. Pure string transformation — no Web Speech
// dependency to mock.

import { describe, expect, it } from "vitest";
import { prepareTextForSpeech } from "../src/lib/tts";

describe("prepareTextForSpeech", () => {
  it("returns plain prose unchanged (modulo whitespace condense)", () => {
    expect(prepareTextForSpeech("Hello world.")).toBe("Hello world.");
  });

  it("collapses a code block into a `[code block]` stub", () => {
    const text = "Before.\n```ts\nconst x = 1;\n```\nAfter.";
    expect(prepareTextForSpeech(text)).toBe("Before. [code block] After.");
  });

  it("strips inline code backticks but keeps the body", () => {
    expect(prepareTextForSpeech("Use the `foo` helper.")).toBe("Use the foo helper.");
  });

  it("strips bold + italic markers", () => {
    expect(prepareTextForSpeech("This is **bold** and *italic*."))
      .toBe("This is bold and italic.");
  });

  it("reads link labels, drops the URL", () => {
    expect(prepareTextForSpeech("Check [the docs](https://example.com/page) please."))
      .toBe("Check the docs please.");
  });

  it("collapses runs of whitespace introduced by stripping", () => {
    const text = "A     B\n\n\nC";
    expect(prepareTextForSpeech(text)).toBe("A B C");
  });

  it("trims leading/trailing whitespace", () => {
    expect(prepareTextForSpeech("   hello   ")).toBe("hello");
  });

  it("handles a chained sample: bold, code fence, and a link in one", () => {
    const text = "**Heads up:** see ```ts\nbug();\n``` and [the report](https://x).";
    expect(prepareTextForSpeech(text))
      .toBe("Heads up: see [code block] and the report.");
  });
});
