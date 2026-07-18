// FILE: workspace-handler-provider-images.test.js
// Purpose: Verifies workspace/readImage routes its generated-images allowlist
//          through the active provider's generatedImagesDir hook rather than
//          importing Codex helpers directly.
// Layer: Unit test
// Exports: node:test suite
// Depends on: node:test, node:assert/strict, fs, os, path, ../src/workspace-handler

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { handleWorkspaceMethod } = require("../../src/handlers/workspace-handler");

const validOnePixelPNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64"
);

test("workspace/readImage allows images under the option-provided generatedImagesDir", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agnt-ws-images-"));
  const generatedRoot = path.join(tmpDir, "agent-generated");
  fs.mkdirSync(generatedRoot, { recursive: true });
  const imagePath = path.join(generatedRoot, "ig_42.png");
  fs.writeFileSync(imagePath, validOnePixelPNG);

  try {
    const result = await handleWorkspaceMethod(
      "workspace/readImage",
      { path: imagePath },
      { generatedImagesDir: () => generatedRoot }
    );
    assert.equal(result.path, fs.realpathSync(imagePath));
    assert.equal(result.dataBase64, validOnePixelPNG.toString("base64"));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("workspace/readImage accepts a null-returning generatedImagesDir thunk without crashing", async () => {
  // Tmp-screenshot allowlist still allows the image because os.tmpdir() is a
  // recognized screenshot root, but the read must succeed without errors when
  // the provider's generatedImagesDir resolver returns null.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agnt-ws-null-"));
  const imagePath = path.join(tmpDir, "screenshot.png");
  fs.writeFileSync(imagePath, validOnePixelPNG);

  try {
    const result = await handleWorkspaceMethod(
      "workspace/readImage",
      { path: imagePath },
      { generatedImagesDir: () => null }
    );
    assert.equal(result.path, fs.realpathSync(imagePath));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("workspace/readImage swallows a throwing generatedImagesDir thunk", async () => {
  // Provider hook misbehaving must not crash the workspace read. Falling back
  // to "no generated-images allowlist" is the right degradation.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agnt-ws-throw-"));
  const imagePath = path.join(tmpDir, "image.png");
  fs.writeFileSync(imagePath, validOnePixelPNG);

  try {
    const result = await handleWorkspaceMethod(
      "workspace/readImage",
      { path: imagePath },
      { generatedImagesDir: () => { throw new Error("provider blew up"); } }
    );
    assert.equal(result.path, fs.realpathSync(imagePath));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("image_path_not_allowed error message no longer hardcodes 'Codex'", () => {
  // The wording change is part of making the handler agent-agnostic. Inspect
  // the source so the assertion is independent of the tricky "image outside
  // temp" rejection path (which is already covered by workspace-image.test.js).
  const handlerSource = fs.readFileSync(
    path.join(__dirname, "..", "..", "src", "handlers", "workspace-read-image.js"),
    "utf8"
  );
  assert.doesNotMatch(handlerSource, /Codex generated images/);
  assert.match(handlerSource, /the active agent's generated images/);
});
