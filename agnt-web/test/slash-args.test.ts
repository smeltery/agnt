// Slash-command argument expansion. The composer parses the user's text
// after `/cmdname …` into argv-style positional args; the variable
// expander folds them into `{1}` / `{2}` / `$ARGUMENTS` placeholders in
// user-defined snippet bodies.

import { describe, expect, it } from "vitest";
import {
  describeBodyArgs,
  expandSlashVariables,
  parseSlashArgs,
} from "../src/lib/slash-variables";

describe("parseSlashArgs", () => {
  it("returns [] for an empty / whitespace-only string", () => {
    expect(parseSlashArgs("")).toEqual([]);
    expect(parseSlashArgs("   ")).toEqual([]);
  });

  it("splits on whitespace", () => {
    expect(parseSlashArgs("a b c")).toEqual(["a", "b", "c"]);
    expect(parseSlashArgs("a   b")).toEqual(["a", "b"]);
  });

  it("preserves quoted runs", () => {
    expect(parseSlashArgs(`"hello world" foo`)).toEqual(["hello world", "foo"]);
    expect(parseSlashArgs(`'a b' 'c d'`)).toEqual(["a b", "c d"]);
  });

  it("handles mixed quoted + bare tokens", () => {
    expect(parseSlashArgs(`first "second arg" third`)).toEqual([
      "first",
      "second arg",
      "third",
    ]);
  });
});

describe("expandSlashVariables — args", () => {
  it("interpolates positional placeholders", () => {
    expect(
      expandSlashVariables("rename {1} to {2}", { args: ["foo.ts", "bar.ts"] })
    ).toBe("rename foo.ts to bar.ts");
  });

  it("expands `$ARGUMENTS` to the joined arg list", () => {
    expect(
      expandSlashVariables("Run: $ARGUMENTS", { args: ["a", "b", "c"] })
    ).toBe("Run: a b c");
  });

  it("treats missing positional args as empty (not literal `{2}`)", () => {
    expect(expandSlashVariables("hi {1} {2}", { args: ["world"] })).toBe(
      "hi world "
    );
  });

  it("leaves the literal `{0}` alone (1-based indexing)", () => {
    expect(expandSlashVariables("got {0}", { args: ["x"] })).toBe("got {0}");
  });

  it("keeps the prior named-token behavior intact", () => {
    expect(
      expandSlashVariables("at {cwd} for {threadtitle}", {
        cwd: "/tmp",
        threadTitle: "ticket",
      })
    ).toBe("at /tmp for ticket");
  });

  it("expands `$ARGUMENTS` and `{1}` together on one body", () => {
    expect(
      expandSlashVariables("first={1} all=$ARGUMENTS", { args: ["a", "b"] })
    ).toBe("first=a all=a b");
  });
});

describe("describeBodyArgs", () => {
  it("returns 0 / false for a body with no placeholders", () => {
    expect(describeBodyArgs("plain body")).toEqual({ positional: 0, arguments: false });
  });

  it("reports the highest positional index", () => {
    expect(describeBodyArgs("{1} {3} {2}")).toEqual({
      positional: 3,
      arguments: false,
    });
  });

  it("flags `$ARGUMENTS` separately", () => {
    expect(describeBodyArgs("Run: $ARGUMENTS")).toEqual({
      positional: 0,
      arguments: true,
    });
  });

  it("ignores `{name}` named tokens", () => {
    expect(describeBodyArgs("at {cwd}")).toEqual({ positional: 0, arguments: false });
  });
});
