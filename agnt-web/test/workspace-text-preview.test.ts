import { beforeEach, describe, expect, it } from "vitest";
import { formatWorkspaceFileSize, isLocalWorkspaceLink, languageForWorkspacePath } from "../src/lib/workspace-text-preview";
import {
  __resetWorkspaceFileCacheForTests,
  useWorkspaceFileCache,
} from "../src/state/workspace-file-cache";

describe("workspace text preview helpers", () => {
  it("detects local workspace links without allowing URL schemes", () => {
    expect(isLocalWorkspaceLink("README.md")).toBe(true);
    expect(isLocalWorkspaceLink("./src/app.ts")).toBe(true);
    expect(isLocalWorkspaceLink("#intro")).toBe(false);
    expect(isLocalWorkspaceLink("https://example.com")).toBe(false);
    expect(isLocalWorkspaceLink("file:///etc/passwd")).toBe(false);
  });

  it("maps workspace paths to supported Prism languages", () => {
    expect(languageForWorkspacePath("src/main.ts")).toBe("typescript");
    expect(languageForWorkspacePath("Dockerfile")).toBe("bash");
    expect(languageForWorkspacePath("notes.unknown")).toBeNull();
  });

  it("formats byte sizes compactly", () => {
    expect(formatWorkspaceFileSize(512)).toBe("512 B");
    expect(formatWorkspaceFileSize(1536)).toBe("1.5 KB");
    expect(formatWorkspaceFileSize(2 * 1024 * 1024)).toBe("2.0 MB");
  });
});

describe("workspace file cache", () => {
  beforeEach(() => {
    __resetWorkspaceFileCacheForTests();
  });

  it("reads and stores workspace text files", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const rpc = {
      async request(method: string, params: unknown) {
        calls.push({ method, params });
        return {
          path: "README.md",
          fileName: "README.md",
          byteLength: 12,
          mtimeMs: 10,
          encoding: "utf8",
          lineCount: 2,
          content: "hello\nworld\n",
        };
      },
    };

    const entry = await useWorkspaceFileCache.getState().ensure(rpc as never, { cwd: "/repo", path: "README.md" });

    expect(entry?.content).toBe("hello\nworld\n");
    expect(entry?.lineCount).toBe(2);
    expect(calls[0]).toMatchObject({ method: "workspace/readFile" });
  });

  it("returns cached content when the bridge reports notModified", async () => {
    let callCount = 0;
    const rpc = {
      async request(_method: string, params: { ifByteLength?: number; ifMtimeMs?: number }) {
        callCount += 1;
        if (callCount === 1) {
          return {
            path: "src/app.ts",
            fileName: "app.ts",
            byteLength: 9,
            mtimeMs: 20,
            encoding: "utf8",
            content: "let x = 1",
          };
        }
        expect(params.ifByteLength).toBe(9);
        expect(params.ifMtimeMs).toBe(20);
        return {
          path: "src/app.ts",
          fileName: "app.ts",
          byteLength: 9,
          mtimeMs: 20,
          encoding: "utf8",
          notModified: true,
        };
      },
    };

    const first = await useWorkspaceFileCache.getState().ensure(rpc as never, { cwd: "/repo", path: "src/app.ts" });
    const second = await useWorkspaceFileCache.getState().ensure(rpc as never, { cwd: "/repo", path: "src/app.ts" });

    expect(second).toBe(first);
    expect(second?.content).toBe("let x = 1");
    expect(callCount).toBe(2);
  });
});
