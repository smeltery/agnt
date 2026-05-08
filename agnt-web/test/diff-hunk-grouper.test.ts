// Hunk grouper contract: meta lines come before the first `@@`, each `@@`
// starts a new group, and the trailing-space match avoids misclassifying a
// content line that happens to begin with `@@`.

import { describe, expect, it } from "vitest";
import { groupDiffByHunks } from "../src/lib/diff-hunk-grouper";

const PATCH = `diff --git a/src/x.ts b/src/x.ts
index abc..def 100644
--- a/src/x.ts
+++ b/src/x.ts
@@ -1,3 +1,3 @@ context-x
 line one
-old line two
+new line two
 line three
@@ -10,2 +10,3 @@ context-y
 line ten
+inserted at eleven
 line twelve
`;

describe("groupDiffByHunks", () => {
  it("returns empty groups for empty input", () => {
    expect(groupDiffByHunks("")).toEqual({ meta: [], hunks: [] });
  });

  it("collects pre-hunk lines into meta", () => {
    const groups = groupDiffByHunks(PATCH);
    expect(groups.meta).toEqual([
      "diff --git a/src/x.ts b/src/x.ts",
      "index abc..def 100644",
      "--- a/src/x.ts",
      "+++ b/src/x.ts",
    ]);
  });

  it("yields one hunk per `@@` header with its body", () => {
    const groups = groupDiffByHunks(PATCH);
    expect(groups.hunks).toHaveLength(2);
    expect(groups.hunks[0].header).toBe("@@ -1,3 +1,3 @@ context-x");
    expect(groups.hunks[0].body).toContain("+new line two");
    expect(groups.hunks[1].header).toBe("@@ -10,2 +10,3 @@ context-y");
    expect(groups.hunks[1].body).toContain("+inserted at eleven");
    // Indices stay stable for React keys.
    expect(groups.hunks.map((hunk) => hunk.index)).toEqual([0, 1]);
  });

  it("treats `@@something` (no trailing space) as a body line, not a hunk", () => {
    // Realistic-ish: a TS template literal that starts with `@@`. The
    // grouper must keep this in the previous hunk's body, otherwise the
    // toggle UI would split mid-hunk.
    const trickyPatch = `@@ -1,2 +1,3 @@
 keep
+@@stillBody
+normal addition
`;
    const groups = groupDiffByHunks(trickyPatch);
    expect(groups.hunks).toHaveLength(1);
    expect(groups.hunks[0].body).toEqual([" keep", "+@@stillBody", "+normal addition", ""]);
  });
});
