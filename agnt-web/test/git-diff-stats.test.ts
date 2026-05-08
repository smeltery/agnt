// Pure +/- counter contract: count `+` and `-` lines but skip the file
// headers (`+++` / `---`), the hunk markers (`@@`), and the diff metadata
// (`diff --git`, `index`).

import { describe, expect, it } from "vitest";
import { computeDiffStats, formatDiffStats, sumDiffStats } from "../src/lib/git-diff-stats";

const PATCH = `diff --git a/src/a.ts b/src/a.ts
index 1..2 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 unchanged
-old line
+new line
+second new line
 unchanged
`;

describe("computeDiffStats", () => {
  it("returns zeros for empty input", () => {
    expect(computeDiffStats("")).toEqual({ insertions: 0, deletions: 0 });
  });

  it("counts only data lines", () => {
    const stats = computeDiffStats(PATCH);
    expect(stats).toEqual({ insertions: 2, deletions: 1 });
  });

  it("ignores the file-header `+++` / `---` lines", () => {
    const headerOnly = `diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -0,0 +1,1 @@\n+only addition\n`;
    expect(computeDiffStats(headerOnly)).toEqual({ insertions: 1, deletions: 0 });
  });

  it("sums multiple stats objects", () => {
    expect(
      sumDiffStats([
        { insertions: 3, deletions: 1 },
        { insertions: 0, deletions: 4 },
        { insertions: 7, deletions: 2 },
      ])
    ).toEqual({ insertions: 10, deletions: 7 });
  });

  it("formats with the unicode minus so columns line up", () => {
    expect(formatDiffStats({ insertions: 5, deletions: 2 })).toBe("+5 −2");
  });
});
