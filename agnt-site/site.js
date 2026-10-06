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

const scenes = {
  followup: {
    prompt: "Nice. Add a manual toggle, too.",
    reply:
      "Added a theme toggle to the header. Your choice persists between visits.",
    state: "Ready for your next idea",
  },
  review: {
    prompt: "What changed in the header?",
    reply:
      "A theme switch, an accessible label, and a saved preference. The existing navigation stays in place.",
    state: "Changes ready to review",
  },
  next: {
    prompt: "Now check the mobile layout.",
    reply:
      "I’ll check the header at smaller widths and make sure the theme switch stays easy to reach.",
    state: "Working on your next idea",
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
    document.querySelectorAll("[data-provider-name]").forEach((label) => {
      label.textContent = provider.name;
    });
    document.querySelectorAll(".agent-symbol").forEach((symbol) => {
      symbol.src = provider.logo;
    });
    document.querySelector("#provider-detail").textContent = provider.detail;
  });
});

document.querySelectorAll("[data-scene]").forEach((button) => {
  button.addEventListener("click", () => {
    const scene = scenes[button.dataset.scene];
    selectButton(button, "[data-scene]");
    document.querySelector("#demo-prompt").textContent = scene.prompt;
    document.querySelector("#demo-reply").textContent = scene.reply;
    document.querySelector("#demo-state").textContent = scene.state;
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
