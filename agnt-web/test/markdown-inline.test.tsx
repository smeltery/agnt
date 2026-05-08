// The inline tokenizer is internal to MarkdownContent.tsx; it isn't exported
// so we test the behavior end-to-end by rendering through the component
// would need a DOM env. Instead these are sanity-checks against a re-export
// shim: the patterns themselves live alongside the component, but the
// tokenizer's behavior can be verified by checking what comes back when we
// drive renderInlineFragments through React's renderToStaticMarkup.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownContent } from "../src/components/chat/MarkdownContent";

function render(text: string): string {
  return renderToStaticMarkup(<MarkdownContent text={text} />);
}

describe("inline markdown — links", () => {
  it("renders [text](https://example.com) as an external <a>", () => {
    const html = render("Visit [Example](https://example.com).");
    expect(html).toContain("<a href=\"https://example.com\"");
    expect(html).toContain("target=\"_blank\"");
    expect(html).toContain(">Example</a>");
  });

  it("renders mailto: links", () => {
    expect(render("[ping](mailto:hi@example.com)")).toContain("href=\"mailto:hi@example.com\"");
  });

  it("renders fragment-only links (#anchor)", () => {
    expect(render("[top](#top)")).toContain("href=\"#top\"");
  });

  it("refuses javascript: schemes (renders the raw markdown)", () => {
    const html = render("[click](javascript:alert(1))");
    expect(html).not.toContain("href=\"javascript:");
    expect(html).toContain("[click]");
  });

  it("refuses unknown schemes", () => {
    expect(render("[x](file:///etc/passwd)")).not.toContain("href=\"file:");
  });
});

describe("inline markdown — images", () => {
  it("renders ![alt](https://...) as an <img>", () => {
    const html = render("![alpha](https://example.com/a.png)");
    expect(html).toContain("<img");
    expect(html).toContain("src=\"https://example.com/a.png\"");
    expect(html).toContain("alt=\"alpha\"");
  });

  it("renders data:image/* sources (lets bridge-emitted previews work inline)", () => {
    const html = render("![pic](data:image/png;base64,iVBORw0KG)");
    expect(html).toContain("src=\"data:image/png;base64,iVBORw0KG\"");
  });

  it("refuses non-image data URIs", () => {
    const html = render("![evil](data:text/html,<script>x</script>)");
    expect(html).not.toContain("<img");
  });

  it("falls back alt text to title when alt is empty", () => {
    const html = render('![](https://example.com/b.png "tooltip")');
    expect(html).toContain("alt=\"tooltip\"");
  });
});
