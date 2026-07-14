// FILE: git-handler-ai-pr.test.js
// Purpose: Covers generated commit messages, PR drafts, and stacked git actions.
// Layer: Unit Test
// Exports: node:test cases
// Depends on: node:test, assert, fs, path, git-handler, git-handler-test-helpers

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { __test } = require("../../src/git/git-handler");
const { git, makeTempRepo, makeBareRemote } = require("./git-handler-test-helpers");

test.afterEach(() => {
  __test.resetRunStructuredCodexJsonImplementation();
  __test.resetRunGitHubCliImplementation();
});

test("gitGenerateCommitMessage forwards the selected model and includes tracked plus untracked changes", async () => {
  const repoDir = makeTempRepo();
  let capturedInvocation = null;

  try {
    fs.writeFileSync(path.join(repoDir, "README.md"), "# Test\n\nupdated\n");
    fs.writeFileSync(path.join(repoDir, "new-file.txt"), "hello from untracked\n");

    __test.setRunStructuredCodexJsonImplementation(async (payload) => {
      capturedInvocation = payload;
      return {
        subject: "Update repository docs",
        body: "- Refresh the README content\n- Add a new untracked file for the workflow",
        fullMessage: "ignored by normalization",
      };
    });

    const result = await __test.gitGenerateCommitMessage(repoDir, { model: "gpt-5.4-mini" });

    assert.equal(result.subject, "Update repository docs");
    assert.equal(
      result.fullMessage,
      "Update repository docs\n\n- Refresh the README content\n- Add a new untracked file for the workflow"
    );
    assert.equal(capturedInvocation?.model, "gpt-5.4-mini");
    assert.equal(capturedInvocation?.cwd, repoDir);
    assert.match(capturedInvocation?.prompt || "", /README\.md/);
    assert.match(capturedInvocation?.prompt || "", /new-file\.txt/);
    assert.match(capturedInvocation?.prompt || "", /updated/);
    assert.match(capturedInvocation?.prompt || "", /hello from untracked/);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("gitGeneratePullRequestDraft summarizes branch changes against the default branch", async () => {
  const repoDir = makeTempRepo();
  const remoteDir = makeBareRemote();
  let capturedInvocation = null;

  try {
    git(remoteDir, "init", "--bare");
    git(repoDir, "remote", "add", "origin", remoteDir);
    git(repoDir, "push", "-u", "origin", "main");
    git(repoDir, "checkout", "-b", "agnt/pr-draft");
    fs.writeFileSync(path.join(repoDir, "README.md"), "# Test\n\nbranch change\n");
    git(repoDir, "add", "README.md");
    git(repoDir, "commit", "-m", "Update readme on branch");

    __test.setRunStructuredCodexJsonImplementation(async (payload) => {
      capturedInvocation = payload;
      return {
        title: "Improve README branch summary",
        body: "## Summary\n- Update the README content for the branch\n\n## Testing\n- Not run (not requested)\n\n## Notes\n- Keeps the change scoped to documentation",
      };
    });

    const result = await __test.gitGeneratePullRequestDraft(repoDir, { model: "gpt-5.4-mini", baseBranch: "main" });

    assert.equal(result.title, "Improve README branch summary");
    assert.match(capturedInvocation?.prompt || "", /Base branch: main/);
    assert.match(capturedInvocation?.prompt || "", /Current branch: agnt\/pr-draft/);
    assert.match(capturedInvocation?.prompt || "", /Update readme on branch/);
    assert.match(capturedInvocation?.prompt || "", /branch change/);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(remoteDir, { recursive: true, force: true });
  }
});

test("gitGenerateCommitMessage surfaces generation failures without falling back to a default message", async () => {
  const repoDir = makeTempRepo();

  try {
    fs.writeFileSync(path.join(repoDir, "README.md"), "# Test\n\nupdated\n");

    __test.setRunStructuredCodexJsonImplementation(async () => {
      throw new Error("Auth failed");
    });

    await assert.rejects(
      __test.gitGenerateCommitMessage(repoDir, { model: "gpt-5.4-mini" }),
      (error) =>
        error?.errorCode === "commit_message_generation_failed"
          && error?.userMessage === "Could not generate a commit message. Auth failed."
    );
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("gitGenerateCommitMessage supports repositories without an initial commit", async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "agnt-git-handler-unborn-"));
  let capturedInvocation = null;

  try {
    git(repoDir, "init", "-b", "main");
    git(repoDir, "config", "user.name", "agnt Tests");
    git(repoDir, "config", "user.email", "tests@example.com");
    fs.writeFileSync(path.join(repoDir, "README.md"), "# First commit\n");

    __test.setRunStructuredCodexJsonImplementation(async (payload) => {
      capturedInvocation = payload;
      return {
        subject: "Create initial project files",
        body: "- Add the first tracked project file\n- Prepare the repository for its initial commit",
        fullMessage: "ignored by normalization",
      };
    });

    const result = await __test.gitGenerateCommitMessage(repoDir, { model: "gpt-5.4-mini" });

    assert.equal(result.subject, "Create initial project files");
    assert.match(capturedInvocation?.prompt || "", /README\.md/);
    assert.match(capturedInvocation?.prompt || "", /First commit/);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("gitCreatePullRequest creates a real GitHub PR through gh", async () => {
  const repoDir = makeTempRepo();
  const remoteDir = makeBareRemote();
  const ghCalls = [];
  let capturedBody = "";

  try {
    git(remoteDir, "init", "--bare");
    git(repoDir, "remote", "add", "origin", remoteDir);
    git(repoDir, "push", "-u", "origin", "main");
    git(repoDir, "checkout", "-b", "agnt/create-pr");
    fs.writeFileSync(path.join(repoDir, "README.md"), "# Test\n\nreal pr\n");
    git(repoDir, "add", "README.md");
    git(repoDir, "commit", "-m", "Prepare PR branch");
    git(repoDir, "push", "-u", "origin", "agnt/create-pr");

    __test.setRunStructuredCodexJsonImplementation(async () => ({
      title: "Prepare PR branch",
      body: "## Summary\n- Add PR branch content\n\n## Testing\n- Not run\n\n## Notes\n- Test draft",
    }));
    __test.setRunGitHubCliImplementation(async (_cwd, args) => {
      ghCalls.push(args);
      if (args.join(" ") === "auth status") {
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "pr" && args[1] === "list") {
        const created = ghCalls.some((call) => call[0] === "pr" && call[1] === "create");
        return {
          stdout: created
            ? JSON.stringify([
                {
                  number: 42,
                  title: "Prepare PR branch",
                  url: "https://github.com/example/repo/pull/42",
                  baseRefName: "main",
                  headRefName: "agnt/create-pr",
                  state: "open",
                },
              ])
            : "[]",
          stderr: "",
        };
      }
      if (args[0] === "pr" && args[1] === "create") {
        const bodyFile = args[args.indexOf("--body-file") + 1];
        capturedBody = fs.readFileSync(bodyFile, "utf8");
        return { stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    });

    const result = await __test.gitCreatePullRequest(repoDir, { baseBranch: "main" });

    assert.equal(result.status, "created");
    assert.equal(result.number, 42);
    assert.equal(result.url, "https://github.com/example/repo/pull/42");
    assert.match(capturedBody, /Add PR branch content/);
    assert.ok(ghCalls.some((call) => call.join(" ").includes("pr create --base main --head agnt/create-pr")));
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(remoteDir, { recursive: true, force: true });
  }
});

test("gitRunStackedAction commits pushes and creates a PR", async () => {
  const repoDir = makeTempRepo();
  const remoteDir = makeBareRemote();
  const ghCalls = [];

  try {
    git(remoteDir, "init", "--bare");
    git(repoDir, "remote", "add", "origin", remoteDir);
    git(repoDir, "push", "-u", "origin", "main");
    git(repoDir, "checkout", "-b", "agnt/stacked-pr");
    fs.writeFileSync(path.join(repoDir, "README.md"), "# Test\n\nstacked action\n");

    __test.setRunStructuredCodexJsonImplementation(async () => ({
      title: "Stacked PR",
      body: "## Summary\n- Commit, push, and create PR\n\n## Testing\n- Not run\n\n## Notes\n- Test draft",
    }));
    __test.setRunGitHubCliImplementation(async (_cwd, args) => {
      ghCalls.push(args);
      if (args.join(" ") === "auth status") {
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "pr" && args[1] === "list") {
        const created = ghCalls.some((call) => call[0] === "pr" && call[1] === "create");
        return {
          stdout: created
            ? JSON.stringify([
                {
                  number: 7,
                  title: "Stacked PR",
                  url: "https://github.com/example/repo/pull/7",
                  baseRefName: "main",
                  headRefName: "agnt/stacked-pr",
                  state: "open",
                },
              ])
            : "[]",
          stderr: "",
        };
      }
      if (args[0] === "pr" && args[1] === "create") {
        return { stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    });

    const result = await __test.gitRunStackedAction(repoDir, {
      action: "commit_push_pr",
      commitMessage: "Update stacked action fixture",
      baseBranch: "main",
    });

    assert.equal(result.commit.status, "created");
    assert.equal(result.push.state, "pushed");
    assert.equal(result.pr.status, "created");
    assert.equal(result.pr.number, 7);
    assert.equal(git(repoDir, "status", "--porcelain"), "");
    assert.match(git(repoDir, "log", "-1", "--pretty=%s"), /Update stacked action fixture/);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(remoteDir, { recursive: true, force: true });
  }
});

test("gitRunStackedAction creates PR from ahead default branch against remote base", async () => {
  const repoDir = makeTempRepo();
  const remoteDir = makeBareRemote();
  const ghCalls = [];
  let capturedInvocation = null;

  try {
    git(remoteDir, "init", "--bare");
    git(repoDir, "remote", "add", "origin", remoteDir);
    git(repoDir, "push", "-u", "origin", "main");
    fs.writeFileSync(path.join(repoDir, "README.md"), "# Test\n\ndefault branch local commit\n");
    git(repoDir, "add", "README.md");
    git(repoDir, "commit", "-m", "Update default before feature PR");

    __test.setRunStructuredCodexJsonImplementation(async (payload) => {
      capturedInvocation = payload;
      return {
        title: "Move default branch work into a PR",
        body: "## Summary\n- Open the locally committed default-branch work as a PR\n\n## Testing\n- Not run\n\n## Notes\n- Uses the remote default branch as the comparison base",
      };
    });
    __test.setRunGitHubCliImplementation(async (_cwd, args) => {
      ghCalls.push(args);
      if (args.join(" ") === "auth status") {
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "pr" && args[1] === "list") {
        const created = ghCalls.some((call) => call[0] === "pr" && call[1] === "create");
        return {
          stdout: created
            ? JSON.stringify([
                {
                  number: 17,
                  title: "Move default branch work into a PR",
                  url: "https://github.com/example/repo/pull/17",
                  baseRefName: "main",
                  headRefName: "agnt/mobile-pr-20260502000000",
                  state: "open",
                },
              ])
            : "[]",
          stderr: "",
        };
      }
      if (args[0] === "pr" && args[1] === "create") {
        return { stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    });

    const result = await __test.gitRunStackedAction(repoDir, {
      action: "commit_push_pr",
      baseBranch: "main",
      featureBranch: true,
    });

    assert.equal(result.commit.status, "skipped_clean");
    assert.equal(result.push.state, "pushed");
    assert.equal(result.pr.status, "created");
    assert.equal(result.pr.number, 17);
    assert.match(capturedInvocation?.prompt || "", /Update default before feature PR/);
    assert.match(capturedInvocation?.prompt || "", /default branch local commit/);
    assert.notEqual(git(repoDir, "branch", "--show-current"), "main");
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(remoteDir, { recursive: true, force: true });
  }
});

test("gitRunStackedAction rejects clean commit push with nothing to do", async () => {
  const repoDir = makeTempRepo();
  const remoteDir = makeBareRemote();

  try {
    git(remoteDir, "init", "--bare");
    git(repoDir, "remote", "add", "origin", remoteDir);
    git(repoDir, "push", "-u", "origin", "main");

    await assert.rejects(
      __test.gitRunStackedAction(repoDir, { action: "commit_push" }),
      (error) =>
        error?.errorCode === "nothing_to_commit"
          && error?.userMessage === "Nothing to commit or push."
    );
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(remoteDir, { recursive: true, force: true });
  }
});

test("gitRunStackedAction rejects clean push with nothing to push", async () => {
  const repoDir = makeTempRepo();
  const remoteDir = makeBareRemote();

  try {
    git(remoteDir, "init", "--bare");
    git(repoDir, "remote", "add", "origin", remoteDir);
    git(repoDir, "push", "-u", "origin", "main");

    await assert.rejects(
      __test.gitRunStackedAction(repoDir, { action: "push" }),
      (error) =>
        error?.errorCode === "nothing_to_push"
          && error?.userMessage === "Nothing to push."
    );
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(remoteDir, { recursive: true, force: true });
  }
});

test("gitCreatePullRequest returns the URL printed by gh when list lags behind creation", async () => {
  const repoDir = makeTempRepo();
  const remoteDir = makeBareRemote();

  try {
    git(remoteDir, "init", "--bare");
    git(repoDir, "remote", "add", "origin", remoteDir);
    git(repoDir, "push", "-u", "origin", "main");
    git(repoDir, "checkout", "-b", "agnt/stdout-pr-url");
    fs.writeFileSync(path.join(repoDir, "README.md"), "# Test\n\nstdout url\n");
    git(repoDir, "add", "README.md");
    git(repoDir, "commit", "-m", "Prepare stdout URL PR");
    git(repoDir, "push", "-u", "origin", "agnt/stdout-pr-url");

    __test.setRunStructuredCodexJsonImplementation(async () => ({
      title: "Prepare stdout URL PR",
      body: "## Summary\n- Add stdout URL fallback\n\n## Testing\n- Not run\n\n## Notes\n- Test draft",
    }));
    __test.setRunGitHubCliImplementation(async (_cwd, args) => {
      if (args.join(" ") === "auth status") {
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "pr" && args[1] === "list") {
        return { stdout: "[]", stderr: "" };
      }
      if (args[0] === "pr" && args[1] === "create") {
        return { stdout: "https://github.com/example/repo/pull/88\n", stderr: "" };
      }
      throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    });

    const result = await __test.gitCreatePullRequest(repoDir, { baseBranch: "main" });

    assert.equal(result.status, "created");
    assert.equal(result.url, "https://github.com/example/repo/pull/88");
    assert.equal(result.number, null);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(remoteDir, { recursive: true, force: true });
  }
});

test("gitCreatePullRequest preserves nothing-to-compare errors", async () => {
  const repoDir = makeTempRepo();
  const remoteDir = makeBareRemote();

  try {
    git(remoteDir, "init", "--bare");
    git(repoDir, "remote", "add", "origin", remoteDir);
    git(repoDir, "push", "-u", "origin", "main");
    git(repoDir, "checkout", "-b", "agnt/no-pr-diff");
    git(repoDir, "push", "-u", "origin", "agnt/no-pr-diff");

    __test.setRunGitHubCliImplementation(async (_cwd, args) => {
      if (args.join(" ") === "auth status") {
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "pr" && args[1] === "list") {
        return { stdout: "[]", stderr: "" };
      }
      throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    });

    await assert.rejects(
      __test.gitCreatePullRequest(repoDir, { baseBranch: "main" }),
      (error) =>
        error?.errorCode === "nothing_to_compare"
          && error?.userMessage === "No branch changes are available for a pull request."
    );
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(remoteDir, { recursive: true, force: true });
  }
});
