const providers = {
  codex: {
    name: "Codex",
    logo: "./assets/brands/codex.svg",
    detail:
      "Codex · macOS only · Native integration, voice, and Codex desktop mirroring.",
  },
  claude: {
    name: "Claude Code",
    logo: "./assets/brands/claude.svg",
    detail:
      "Claude Code · macOS & Linux · Plan mode, reasoning, and session history.",
  },
  opencode: {
    name: "opencode",
    logo: "./assets/brands/opencode.svg",
    detail:
      "opencode · macOS & Linux · Runtime approvals, session compaction, and forks.",
  },
  cursor: {
    name: "Cursor",
    logo: "./assets/brands/cursor.svg",
    detail:
      "Cursor · macOS & Linux · Model selection and resumable conversations.",
  },
};

function selectButton(button, selector) {
  document.querySelectorAll(selector).forEach((candidate) => {
    const selected = candidate === button;
    candidate.classList.toggle("selected", selected);
    candidate.setAttribute("aria-pressed", String(selected));
  });
}

document.querySelectorAll("[data-provider]").forEach((button) => {
  button.addEventListener("click", () => {
    const provider = providers[button.dataset.provider];
    selectButton(button, "[data-provider]");
    document.querySelector("#provider-detail").textContent = provider.detail;
  });
});

document.querySelector("#copy-command").addEventListener("click", async () => {
  const command = document.querySelector("#setup-command");
  const status = document.querySelector("#copy-status");
  try {
    await navigator.clipboard.writeText(command.textContent.trim());
    status.textContent = "Copied. Paste into a terminal on your host machine.";
  } catch {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(command);
    selection.removeAllRanges();
    selection.addRange(range);
    status.textContent =
      "Clipboard unavailable. Commands selected; copy them manually.";
  }
});
