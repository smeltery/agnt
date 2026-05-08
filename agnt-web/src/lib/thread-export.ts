// Serializes a thread's messages into a single Markdown document users can
// download. Pure function so the only side effect is whatever the caller does
// with the returned text. We only emit roles/kinds the bridge actually
// produces — anything we don't recognize gets dropped rather than guessed.

import type { CodexMessage, CodexThread } from "../models";

export interface ExportThreadOptions {
  thread: Pick<CodexThread, "id" | "title" | "name" | "cwd" | "modelProvider" | "model"> | undefined;
  messages: CodexMessage[];
  exportedAt?: Date;
}

export function exportThreadToMarkdown(options: ExportThreadOptions): string {
  const lines: string[] = [];
  const title = options.thread?.name ?? options.thread?.title ?? "Untitled thread";
  const exportedAt = options.exportedAt ?? new Date();

  lines.push(`# ${title}`, "");
  if (options.thread?.cwd) lines.push(`- **cwd:** \`${options.thread.cwd}\``);
  if (options.thread?.modelProvider) lines.push(`- **provider:** ${options.thread.modelProvider}`);
  if (options.thread?.model) lines.push(`- **model:** \`${options.thread.model}\``);
  lines.push(`- **exported:** ${exportedAt.toISOString()}`, "");
  lines.push("---", "");

  for (const message of options.messages) {
    const block = renderMessage(message);
    if (!block) continue;
    lines.push(block, "");
  }

  return lines.join("\n").trimEnd() + "\n";
}

function renderMessage(message: CodexMessage): string | null {
  if (message.role === "user") return renderUser(message);
  if (message.role === "system" && message.deliveryState === "failed") return renderFailure(message);

  switch (message.kind) {
    case "thinking":
      return renderReasoning(message);
    case "commandExecution":
      return renderCommand(message);
    case "fileChange":
      return renderFileChange(message);
    case "toolActivity":
      return renderTool(message);
    case "plan":
      return renderPlan(message);
    case "chat":
      return renderAssistant(message);
    default:
      return message.text ? `## ${labelFor(message)}\n\n${message.text}` : null;
  }
}

function renderUser(message: CodexMessage): string {
  const parts = [`## You`, ""];
  for (const attachment of message.attachments ?? []) {
    parts.push(`> 🖼 attached: ${attachment.fileName ?? "image"}`);
  }
  if (message.text) parts.push(message.text);
  return parts.join("\n");
}

function renderAssistant(message: CodexMessage): string {
  // Empty assistant rows happen when a turn was steered before any text
  // arrived. Skipping them keeps the export tidy.
  if (!message.text.trim()) return "";
  return `## Assistant\n\n${message.text}`;
}

function renderReasoning(message: CodexMessage): string {
  if (!message.text.trim()) return "";
  // Wrap reasoning in a <details> so it's collapsed by default in any
  // markdown renderer that supports HTML (GitHub, most viewers).
  return `<details>\n<summary>Reasoning</summary>\n\n${message.text}\n\n</details>`;
}

function renderCommand(message: CodexMessage): string {
  const command = message.command;
  if (!command) return "";
  const lines = ["### Command"];
  lines.push("```bash", command.fullCommand || "(no command captured)", "```");
  if (command.outputTail) {
    lines.push("", "<details>", "<summary>Output</summary>", "", "```text", command.outputTail, "```", "", "</details>");
  }
  if (command.exitCode !== undefined) {
    lines.push("", `_exit ${command.exitCode}${command.durationMs !== undefined ? ` · ${(command.durationMs / 1000).toFixed(2)}s` : ""}_`);
  }
  return lines.join("\n");
}

function renderFileChange(message: CodexMessage): string {
  const fileChange = message.fileChange;
  if (!fileChange?.diff) return "";
  return `### File change${fileChange.path ? ` — \`${fileChange.path}\`` : ""}\n\n\`\`\`diff\n${fileChange.diff}\n\`\`\``;
}

function renderTool(message: CodexMessage): string {
  if (!message.text.trim()) return "";
  return `### Tool\n\n${message.text}`;
}

function renderPlan(message: CodexMessage): string {
  const plan = message.plan;
  if (!plan) return message.text ? `### Plan\n\n${message.text}` : "";
  const lines = ["### Plan"];
  if (plan.explanation) lines.push("", plan.explanation);
  if (plan.steps.length) {
    lines.push("");
    for (const step of plan.steps) {
      const checkbox = step.status === "completed" ? "x" : step.status === "failed" ? "!" : " ";
      lines.push(`- [${checkbox}] ${step.step}`);
    }
  }
  if (message.text) lines.push("", message.text);
  return lines.join("\n");
}

function renderFailure(message: CodexMessage): string {
  return `> ⚠ Turn failed: ${message.text}`;
}

function labelFor(message: CodexMessage): string {
  switch (message.role) {
    case "user":
      return "You";
    case "assistant":
      return "Assistant";
    default:
      return "System";
  }
}

/**
 * Concatenates multiple thread exports into a single Markdown document — used
 * by the sidebar's bulk-export action. Each thread keeps its full header and
 * is separated from the next by a horizontal rule, so users get one file
 * instead of N spawned downloads.
 */
export function exportThreadsToMarkdown(threads: ExportThreadOptions[], exportedAt: Date = new Date()): string {
  const parts: string[] = [];
  parts.push(`# Threads export (${threads.length})`, "");
  parts.push(`- **exported:** ${exportedAt.toISOString()}`, "");
  parts.push("---", "");
  for (const thread of threads) {
    parts.push(exportThreadToMarkdown({ ...thread, exportedAt }).trimEnd(), "", "---", "");
  }
  return parts.join("\n").trimEnd() + "\n";
}

/**
 * Structured JSON export. Useful for piping a thread into other tools (search
 * indices, downstream LLMs, archiving). We deliberately serialize a stable
 * shape rather than dumping the in-memory `CodexMessage` — internal flags
 * like `isStreaming` or `deliveryState: "pending"` would never be true at
 * export time but would still be in the type.
 *
 * Image attachments are exported by reference (id + filename + byteLength).
 * The thumbnail/payload data URLs can be tens of MB; users who want them in
 * the export can grab the image via the lightbox separately.
 */
export function exportThreadToJson(options: ExportThreadOptions): string {
  const exportedAt = options.exportedAt ?? new Date();
  const payload = {
    schemaVersion: 1,
    exportedAt: exportedAt.toISOString(),
    thread: options.thread
      ? {
          id: options.thread.id,
          title: options.thread.name ?? options.thread.title,
          cwd: options.thread.cwd,
          modelProvider: options.thread.modelProvider,
          model: options.thread.model,
        }
      : null,
    messages: options.messages.map((message) => ({
      id: message.id,
      role: message.role,
      kind: message.kind,
      text: message.text,
      turnId: message.turnId,
      itemId: message.itemId,
      createdAt: message.createdAt,
      command: message.command
        ? {
            command: message.command.fullCommand,
            outputTail: message.command.outputTail,
            exitCode: message.command.exitCode,
          }
        : undefined,
      fileChange: message.fileChange
        ? {
            path: message.fileChange.path,
            diff: message.fileChange.diff,
          }
        : undefined,
      plan: message.plan
        ? {
            explanation: message.plan.explanation,
            steps: message.plan.steps,
          }
        : undefined,
      attachments: message.attachments?.map((attachment) => ({
        id: attachment.id,
        fileName: attachment.fileName,
        byteLength: attachment.byteLength,
      })),
    })),
  };
  return JSON.stringify(payload, null, 2) + "\n";
}

export function defaultExportFilename(threadTitle: string | undefined): string {
  const slug = (threadTitle ?? "thread")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "thread";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${slug}-${stamp}.md`;
}

export function defaultJsonExportFilename(threadTitle: string | undefined): string {
  return defaultExportFilename(threadTitle).replace(/\.md$/, ".json");
}

export function downloadJson(filename: string, content: string): void {
  downloadBlob(filename, new Blob([content], { type: "application/json;charset=utf-8" }));
}

function downloadBlob(filename: string, blob: Blob): void {
  if (typeof document === "undefined") return;
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadMarkdown(filename: string, content: string): void {
  if (typeof document === "undefined") return;
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
