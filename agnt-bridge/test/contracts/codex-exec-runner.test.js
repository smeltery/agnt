// FILE: contracts/codex-exec-runner.test.js
// Purpose: Pins the Codex CLI exec runner — schema-typed structured-JSON
//          requests that shell out to `codex exec`. The runner is small but
//          fiddly: temp-dir lifecycle, PATH→bundle fallback, ENOENT retry
//          semantics, and the failure-message shape are all easy to regress.
// Layer: Contract test
// Exports: node:test suite

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  CODEX_EXEC_TIMEOUT_MS,
  runStructuredCodexJson,
} = require("../../src/git/codex-exec-runner");

test("CODEX_EXEC_TIMEOUT_MS is the documented 2-minute budget", () => {
  assert.equal(CODEX_EXEC_TIMEOUT_MS, 120_000);
});

test("runStructuredCodexJson rejects with the underlying error when codex is not on PATH and there is no bundled fallback", async () => {
  // Use an empty PATH and a fake `codex` name that cannot resolve. The runner
  // should attempt the spawn, hit ENOENT, and reject because there are no
  // remaining commands to retry.
  const originalPath = process.env.PATH;
  process.env.PATH = "";
  try {
    await assert.rejects(
      runStructuredCodexJson({
        cwd: process.cwd(),
        model: "test-model",
        prompt: "Return a JSON object",
        schema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
        },
      }),
      (error) => {
        // Some platforms emit ENOENT; others emit EACCES (e.g. when PATH is
        // empty and spawn tries the literal name as a path). Either should
        // surface as a real error rather than the runner silently resolving.
        assert.ok(error instanceof Error);
        return true;
      },
    );
  } finally {
    process.env.PATH = originalPath;
  }
});

test("runStructuredCodexJson cleans up its temp directory even when the spawn fails", async () => {
  // Snapshot the tmpdir, run a doomed invocation, and verify no `agnt-codex-exec-*`
  // directories are leaked.
  const tmp = os.tmpdir();
  const before = new Set(fs.readdirSync(tmp).filter((name) => name.startsWith("agnt-codex-exec-")));

  const originalPath = process.env.PATH;
  process.env.PATH = "";
  try {
    await runStructuredCodexJson({
      cwd: process.cwd(),
      model: "test-model",
      prompt: "x",
      schema: { type: "object" },
    }).catch(() => {});
  } finally {
    process.env.PATH = originalPath;
  }

  const after = new Set(fs.readdirSync(tmp).filter((name) => name.startsWith("agnt-codex-exec-")));
  for (const dirName of after) {
    assert.ok(
      before.has(dirName),
      `runStructuredCodexJson must remove its temp directory; leaked ${dirName}`,
    );
  }
});

test("runStructuredCodexJson uses a fake `codex` binary on PATH and returns the parsed JSON it writes", async () => {
  // Build a fake codex CLI that reads its `-o <output>` flag, writes a JSON
  // object there, and exits 0. The runner should hand back the parsed object.
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "agnt-codex-fake-bin-"));
  const fakeCodex = path.join(binDir, "codex");
  fs.writeFileSync(fakeCodex, [
    "#!/bin/sh",
    "# Echo the documented schema-conforming object to the `-o` path.",
    "while [ \"$#\" -gt 0 ]; do",
    "  if [ \"$1\" = \"-o\" ]; then",
    "    printf '%s' '{\"ok\":true,\"value\":42}' > \"$2\"",
    "    break",
    "  fi",
    "  shift",
    "done",
    "exit 0",
  ].join("\n"), { mode: 0o755 });

  const originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${originalPath || ""}`;
  try {
    const result = await runStructuredCodexJson({
      cwd: process.cwd(),
      model: "test-model",
      prompt: "irrelevant — the fake doesn't read stdin",
      schema: {
        type: "object",
        properties: { ok: { type: "boolean" }, value: { type: "number" } },
        required: ["ok", "value"],
      },
    });
    assert.deepEqual(result, { ok: true, value: 42 });
  } finally {
    process.env.PATH = originalPath;
    fs.rmSync(binDir, { recursive: true, force: true });
  }
});

test("runStructuredCodexJson surfaces a non-zero exit as a clean error message including the last stderr line", async () => {
  // Fake codex that writes a useful error line to stderr and exits 7. The
  // runner should reject with an Error carrying that line in the message
  // (the bridge surfaces it to the iOS app as the failure reason).
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "agnt-codex-fake-bin-"));
  const fakeCodex = path.join(binDir, "codex");
  fs.writeFileSync(fakeCodex, [
    "#!/bin/sh",
    "echo 'first line ignored' >&2",
    "echo 'codex policy violation' >&2",
    "exit 7",
  ].join("\n"), { mode: 0o755 });

  const originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${originalPath || ""}`;
  try {
    await assert.rejects(
      runStructuredCodexJson({
        cwd: process.cwd(),
        model: "test-model",
        prompt: "x",
        schema: { type: "object" },
      }),
      (error) => {
        assert.ok(error instanceof Error);
        assert.match(
          error.message,
          /exited with code 7.*codex policy violation/,
          "failure message must include the exit code and the last stderr line",
        );
        return true;
      },
    );
  } finally {
    process.env.PATH = originalPath;
    fs.rmSync(binDir, { recursive: true, force: true });
  }
});

test("runStructuredCodexJson treats an empty `-o` file as a failure", async () => {
  // Codex exits 0 but writes nothing — that's still a failed draft (the
  // structured-JSON contract was not honoured). The runner must surface
  // this as an error, not silently resolve with undefined.
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "agnt-codex-fake-bin-"));
  const fakeCodex = path.join(binDir, "codex");
  fs.writeFileSync(fakeCodex, [
    "#!/bin/sh",
    "# Find -o <path> and touch it (empty) instead of writing JSON.",
    "while [ \"$#\" -gt 0 ]; do",
    "  if [ \"$1\" = \"-o\" ]; then",
    "    : > \"$2\"",
    "    break",
    "  fi",
    "  shift",
    "done",
    "exit 0",
  ].join("\n"), { mode: 0o755 });

  const originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${originalPath || ""}`;
  try {
    await assert.rejects(
      runStructuredCodexJson({
        cwd: process.cwd(),
        model: "test-model",
        prompt: "x",
        schema: { type: "object" },
      }),
      /empty structured response/i,
    );
  } finally {
    process.env.PATH = originalPath;
    fs.rmSync(binDir, { recursive: true, force: true });
  }
});

test("runStructuredCodexJson falls back to the Codex.app bundled CLI when PATH lookup ENOENTs", async () => {
  // Build a fake Codex.app bundle containing a working `codex` at
  // <app>/Contents/Resources/codex. PATH has no codex; the runner should
  // retry against the bundle and succeed.
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), "agnt-codex-fake-app-"));
  const bundledDir = path.join(appDir, "Contents", "Resources");
  fs.mkdirSync(bundledDir, { recursive: true });
  const bundledCodex = path.join(bundledDir, "codex");
  fs.writeFileSync(bundledCodex, [
    "#!/bin/sh",
    "while [ \"$#\" -gt 0 ]; do",
    "  if [ \"$1\" = \"-o\" ]; then",
    "    printf '%s' '{\"source\":\"bundled\"}' > \"$2\"",
    "    break",
    "  fi",
    "  shift",
    "done",
    "exit 0",
  ].join("\n"), { mode: 0o755 });

  const originalPath = process.env.PATH;
  process.env.PATH = "";
  try {
    const result = await runStructuredCodexJson({
      cwd: process.cwd(),
      model: "test-model",
      prompt: "x",
      schema: { type: "object", properties: { source: { type: "string" } } },
      codexAppPath: appDir,
    });
    assert.deepEqual(result, { source: "bundled" });
  } finally {
    process.env.PATH = originalPath;
    fs.rmSync(appDir, { recursive: true, force: true });
  }
});

test("runStructuredCodexJson ignores a Codex.app fallback that doesn't actually contain a bundled CLI", async () => {
  // codexAppPath points at an existing dir but there's no
  // <app>/Contents/Resources/codex inside — the runner should NOT fall back
  // (no bundled command means only the PATH command list, which is empty).
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), "agnt-codex-empty-app-"));
  fs.mkdirSync(path.join(appDir, "Contents", "Resources"), { recursive: true });
  // intentionally no `codex` file inside.

  const originalPath = process.env.PATH;
  process.env.PATH = "";
  try {
    await assert.rejects(
      runStructuredCodexJson({
        cwd: process.cwd(),
        model: "test-model",
        prompt: "x",
        schema: { type: "object" },
        codexAppPath: appDir,
      }),
    );
  } finally {
    process.env.PATH = originalPath;
    fs.rmSync(appDir, { recursive: true, force: true });
  }
});

test("runStructuredCodexJson passes --skip-git-repo-check and -s <sandboxMode> when requested", async () => {
  // Fake codex echoes its argv to the output file so we can introspect what
  // the runner actually invoked. This pins the thread-title path that runs
  // outside a git repo with read-only sandboxing.
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "agnt-codex-args-bin-"));
  const fakeCodex = path.join(binDir, "codex");
  fs.writeFileSync(fakeCodex, [
    "#!/bin/sh",
    "# Capture argv as a JSON array under the -o file.",
    "out_path=''",
    "argv_json=''",
    "for arg in \"$@\"; do",
    "  argv_json=\"$argv_json,\\\"$arg\\\"\"",
    "done",
    "argv_json=\"[${argv_json#,}]\"",
    "while [ \"$#\" -gt 0 ]; do",
    "  if [ \"$1\" = \"-o\" ]; then",
    "    out_path=\"$2\"",
    "    break",
    "  fi",
    "  shift",
    "done",
    "printf '%s' \"{\\\"argv\\\":$argv_json}\" > \"$out_path\"",
    "exit 0",
  ].join("\n"), { mode: 0o755 });

  const originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${originalPath || ""}`;
  try {
    const result = await runStructuredCodexJson({
      cwd: process.cwd(),
      model: "title-model",
      prompt: "thread title prompt",
      schema: { type: "object" },
      skipGitRepoCheck: true,
      sandboxMode: "read-only",
    });
    assert.ok(Array.isArray(result.argv));
    assert.ok(result.argv.includes("--skip-git-repo-check"),
      "skipGitRepoCheck=true must forward --skip-git-repo-check");
    const sIdx = result.argv.indexOf("-s");
    assert.notEqual(sIdx, -1, "sandboxMode must be forwarded as `-s <mode>`");
    assert.equal(result.argv[sIdx + 1], "read-only");
    // Sanity: model + ephemeral + cwd flags also present.
    assert.ok(result.argv.includes("--ephemeral"));
    const mIdx = result.argv.indexOf("-m");
    assert.equal(result.argv[mIdx + 1], "title-model");
  } finally {
    process.env.PATH = originalPath;
    fs.rmSync(binDir, { recursive: true, force: true });
  }
});
