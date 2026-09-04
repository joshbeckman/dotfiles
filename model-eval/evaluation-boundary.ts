import {existsSync, lstatSync, realpathSync} from "node:fs";
import {dirname, isAbsolute, resolve, sep} from "node:path";
import type {ExtensionAPI} from "@earendil-works/pi-coding-agent";

const root = realpathSync(process.env.PI_EVAL_ROOT ?? process.cwd());
const allowedCommands = new Set<string>(JSON.parse(process.env.PI_EVAL_ALLOWED_COMMANDS ?? "[]"));
const commandTimeout = Number(process.env.PI_EVAL_COMMAND_TIMEOUT ?? "10");

function insideRoot(path: string, writing = false): boolean {
  try {
    const candidate = resolve(root, path.replace(/^@/, ""));
    if (existsSync(candidate) && lstatSync(candidate).isSymbolicLink()) return false;
    const checked = realpathSync(existsSync(candidate) ? candidate : writing ? dirname(candidate) : candidate);
    if (checked !== root && !checked.startsWith(root + sep)) return false;
    return true;
  } catch {
    return false;
  }
}

export default function evaluationBoundary(pi: ExtensionAPI) {
  pi.on("tool_call", (event) => {
    const input = event.input as Record<string, unknown>;

    if (["read", "edit", "write"].includes(event.toolName)) {
      const path = typeof input.path === "string" ? input.path : "";
      if (!path || isAbsolute(path) || !insideRoot(path, event.toolName === "write")) {
        return {block: true, reason: `${event.toolName} is restricted to files inside the fixture workspace`};
      }
      return;
    }

    if (event.toolName === "bash") {
      const command = typeof input.command === "string" ? input.command : "";
      if (!allowedCommands.has(command)) {
        return {block: true, reason: "This fixture does not allow that shell command"};
      }
      input.timeout = Math.min(Number(input.timeout ?? commandTimeout), commandTimeout);
      input.command = `/usr/bin/env -i HOME="$PI_EVAL_ROOT" TMPDIR="$PI_EVAL_ROOT" PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" PYTHONDONTWRITEBYTECODE=1 ${command}`;
      return;
    }

    return {block: true, reason: `Tool ${event.toolName} is unavailable in this evaluation`};
  });
}
