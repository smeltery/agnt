// Splitter contract: per-file slices keep their `diff --git` header, paths
// are extracted from the b-side (post-state), and a malformed/empty input
// returns an empty list rather than throwing.

import { describe, expect, it } from "vitest";
import { findFileDiff, splitUnifiedDiff } from "../src/lib/git-diff-parser";

const TWO_FILE_PATCH = `diff --git a/src/a.ts b/src/a.ts
index 1..2 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,1 +1,1 @@
-old a
+new a
diff --git a/src/b.ts b/src/b.ts
index 3..4 100644
--- a/src/b.ts
+++ b/src/b.ts
@@ -1,1 +1,1 @@
-old b
+new b
`;

describe("splitUnifiedDiff", () => {
  it("returns empty for empty input", () => {
    expect(splitUnifiedDiff("")).toEqual([]);
    expect(splitUnifiedDiff("   \n")).toEqual([]);
  });

  it("yields one entry per file", () => {
    const out = splitUnifiedDiff(TWO_FILE_PATCH);
    expect(out).toHaveLength(2);
    expect(out.map((entry) => entry.path)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("includes the diff --git header in each per-file slice", () => {
    const out = splitUnifiedDiff(TWO_FILE_PATCH);
    expect(out[0].patch.startsWith("diff --git a/src/a.ts b/src/a.ts")).toBe(true);
    expect(out[1].patch.startsWith("diff --git a/src/b.ts b/src/b.ts")).toBe(true);
  });

  it("uses the b-side path so a rename's post-state wins", () => {
    const renamePatch = `diff --git a/old-name.ts b/new-name.ts
similarity index 95%
rename from old-name.ts
rename to new-name.ts
`;
    const out = splitUnifiedDiff(renamePatch);
    expect(out[0].path).toBe("new-name.ts");
  });

  it("findFileDiff resolves a single file by path", () => {
    expect(findFileDiff(TWO_FILE_PATCH, "src/b.ts")).toContain("new b");
    expect(findFileDiff(TWO_FILE_PATCH, "missing.ts")).toBeUndefined();
  });
});
