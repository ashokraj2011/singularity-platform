/**
 * M26 — `gh copilot` headless wrapper.
 *
 * Two tools that shell out to the GitHub Copilot CLI extension:
 *   • copilot_suggest  — `gh copilot suggest <prompt>`
 *   • copilot_explain  — `gh copilot explain <command>`
 *
 * Both are MEDIUM risk, no approval (read-only — Copilot returns text, never
 * executes anything). Designed for laptop mode where the user has already
 * run `gh auth login` and `gh extension install github/gh-copilot`.
 *
 * The CLI's TTY-bound interactive mode is bypassed by piping the prompt on
 * stdin and using GH_FORCE_TTY="" so the output is plain text.
 */
import { spawn } from "node:child_process";
import type { ToolHandler } from "./registry";

const COPILOT_TIMEOUT_MS = 30_000;

async function runGh(args: string[], input?: string): Promise<{ stdout: string; stderr: string; exit_code: number }> {
  return new Promise((resolve) => {
    const child = spawn("gh", args, {
      env: { ...process.env, GH_FORCE_TTY: "", PAGER: "cat" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const t = setTimeout(() => {
      child.kill("SIGTERM");
    }, COPILOT_TIMEOUT_MS);
    child.stdout.on("data", (b) => { stdout += b.toString(); });
    child.stderr.on("data", (b) => { stderr += b.toString(); });
    child.on("close", (code) => {
      clearTimeout(t);
      resolve({ stdout, stderr, exit_code: code ?? -1 });
    });
    if (input) {
      try { child.stdin.write(input + "\n"); child.stdin.end(); } catch { /* ignore */ }
    } else {
      child.stdin.end();
    }
  });
}

export const copilotSuggestTool: ToolHandler = {
  descriptor: {
    name: "copilot_suggest",
    description: "Ask GitHub Copilot for a shell-command / gh-command / git-command suggestion. Runs `gh copilot suggest` locally. Returns the text only — never executes the suggestion.",
    natural_language:
      "Use this when the user asks 'how do I do X with the command line', 'what's the gh command for Y', or for a shell incantation suggestion.",
    input_schema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "What to suggest (e.g. 'list all open PRs in the last week')" },
        target: {
          type: "string",
          description: "Optional. One of: shell, gh, git. Default: shell.",
          enum: ["shell", "gh", "git"],
        },
      },
      required: ["prompt"],
    },
    output_schema: {
      type: "object",
      properties: {
        suggestion: { type: "string" },
        exit_code: { type: "number" },
      },
    },
    risk_level: "MEDIUM",
    requires_approval: false,
  },
  async execute(args) {
    const prompt = typeof args.prompt === "string" ? args.prompt : "";
    const target = typeof args.target === "string" ? args.target : "shell";
    if (!prompt) return { success: false, error: "prompt is required", output: null };
    const res = await runGh(["copilot", "suggest", "-t", target, prompt]);
    return {
      success: res.exit_code === 0,
      output: { suggestion: res.stdout.trim(), exit_code: res.exit_code, stderr: res.stderr.trim() || undefined },
      error: res.exit_code === 0 ? undefined : (res.stderr.trim() || `gh copilot exited ${res.exit_code}`),
    };
  },
};

export const copilotExplainTool: ToolHandler = {
  descriptor: {
    name: "copilot_explain",
    description: "Ask GitHub Copilot to explain a shell command. Runs `gh copilot explain` locally.",
    natural_language:
      "Use this when the user asks 'what does this command do' or pastes a one-liner and wants it explained.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to explain" },
      },
      required: ["command"],
    },
    output_schema: {
      type: "object",
      properties: {
        explanation: { type: "string" },
        exit_code: { type: "number" },
      },
    },
    risk_level: "LOW",
    requires_approval: false,
  },
  async execute(args) {
    const command = typeof args.command === "string" ? args.command : "";
    if (!command) return { success: false, error: "command is required", output: null };
    const res = await runGh(["copilot", "explain", command]);
    return {
      success: res.exit_code === 0,
      output: { explanation: res.stdout.trim(), exit_code: res.exit_code, stderr: res.stderr.trim() || undefined },
      error: res.exit_code === 0 ? undefined : (res.stderr.trim() || `gh copilot exited ${res.exit_code}`),
    };
  },
};
