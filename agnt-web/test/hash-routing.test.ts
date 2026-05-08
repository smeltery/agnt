// Hash deep-link contract: parse + build round-trip, percent-encoding for
// thread/message ids that contain unsafe characters, and graceful empty-out
// for malformed input.

import { describe, expect, it } from "vitest";
import { buildHashLocation, buildPermalink, parseHashLocation } from "../src/lib/hash-routing";

describe("parseHashLocation", () => {
  it("returns empty object for unrecognized input", () => {
    expect(parseHashLocation("")).toEqual({});
    expect(parseHashLocation("#something-else")).toEqual({});
  });

  it("parses a thread-only hash", () => {
    expect(parseHashLocation("#thread/abc")).toEqual({ threadId: "abc" });
  });

  it("parses thread + message", () => {
    expect(parseHashLocation("#thread/abc/message/m1")).toEqual({ threadId: "abc", messageId: "m1" });
  });

  it("decodes percent-encoded ids", () => {
    expect(parseHashLocation("#thread/foo%2Fbar")).toEqual({ threadId: "foo/bar" });
  });

  it("ignores trailing /message/ with no id", () => {
    expect(parseHashLocation("#thread/abc/message/")).toEqual({ threadId: "abc" });
  });
});

describe("buildHashLocation", () => {
  it("returns empty for missing threadId", () => {
    expect(buildHashLocation({})).toBe("");
  });

  it("emits #thread/<id> for thread-only", () => {
    expect(buildHashLocation({ threadId: "abc" })).toBe("#thread/abc");
  });

  it("emits the full nested form for thread + message", () => {
    expect(buildHashLocation({ threadId: "abc", messageId: "m1" })).toBe("#thread/abc/message/m1");
  });

  it("percent-encodes ids that contain slashes", () => {
    expect(buildHashLocation({ threadId: "foo/bar" })).toBe("#thread/foo%2Fbar");
  });
});

describe("buildPermalink", () => {
  it("composes origin + pathname + hash", () => {
    expect(
      buildPermalink("https://agnt.example", "/app", { threadId: "t1", messageId: "m1" })
    ).toBe("https://agnt.example/app#thread/t1/message/m1");
  });
});

describe("hash routing round-trip", () => {
  it("preserves thread + message through build → parse", () => {
    const original = { threadId: "with space", messageId: "msg/1" };
    const hash = buildHashLocation(original);
    expect(parseHashLocation(hash)).toEqual(original);
  });
});
