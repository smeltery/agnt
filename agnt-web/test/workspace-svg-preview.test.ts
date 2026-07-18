import { describe, expect, it } from "vitest";
import {
  decodeSvgDataUrl,
  isSvgDataUrl,
  isSvgPath,
  sanitizeWorkspaceSvgSource,
  workspaceSvgHtmlDocument,
} from "../src/lib/workspace-svg-preview";

describe("workspace SVG preview security", () => {
  it("strips external href and src references", () => {
    const source = `<svg><image href="https://example.com/a.png"/><use xlink:href='//cdn.example.com/a#b'/><image src=file:///tmp/a.png /></svg>`;

    const sanitized = sanitizeWorkspaceSvgSource(source);

    expect(sanitized).not.toContain("https://example.com");
    expect(sanitized).not.toContain("//cdn.example.com");
    expect(sanitized).not.toContain("file:///tmp");
    expect(sanitized).toContain("<svg>");
  });

  it("keeps embedded data references", () => {
    const source = `<svg><image href="data:image/png;base64,AAAA"/></svg>`;

    expect(sanitizeWorkspaceSvgSource(source)).toContain("data:image/png");
  });

  it("builds an offline CSP document", () => {
    const html = workspaceSvgHtmlDocument("<svg></svg>", false);

    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain("script-src 'none'");
    expect(html).toContain("connect-src 'none'");
    expect(html).toContain("frame-src 'none'");
  });

  it("detects SVG paths with query, hash, and case", () => {
    expect(isSvgPath("diagram.SVG?cache=1#icon")).toBe(true);
    expect(isSvgPath("diagram.svgz")).toBe(false);
  });

  it("decodes base64 and percent-encoded SVG data URLs", () => {
    const base64 = "data:image/svg+xml;base64," + Buffer.from("<svg><title>x</title></svg>").toString("base64");
    const encoded = "data:image/svg+xml,%3Csvg%3E%3C%2Fsvg%3E";

    expect(isSvgDataUrl(base64)).toBe(true);
    expect(decodeSvgDataUrl(base64)).toContain("<title>x</title>");
    expect(decodeSvgDataUrl(encoded)).toBe("<svg></svg>");
    expect(decodeSvgDataUrl("data:image/png;base64,AAAA")).toBeNull();
  });
});
