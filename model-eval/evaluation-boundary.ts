import {realpathSync, statSync} from "node:fs";
import {dirname, isAbsolute, resolve, sep} from "node:path";
import type {ExtensionAPI} from "@earendil-works/pi-coding-agent";

const root = realpathSync(process.env.PI_EVAL_ROOT ?? process.cwd());
const allowedCommands = new Set<string>(JSON.parse(process.env.PI_EVAL_ALLOWED_COMMANDS ?? "[]"));

function insideRoot(path: string, writing = false): boolean {
  try {
    const candidate = resolve(root, path.replace(/^@/, ""));
    const checked = realpathSync(writing ? dirname(candidate) : candidate);
    if (checked !== root && !checked.startsWith(root + sep)) return false;
    if (!writing && statSync(checked).isSymbolicLink()) return false;
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
      input.timeout = Math.min(Number(input.timeout ?? 10), 10);
      return;
    }

    return {block: true, reason: `Tool ${event.toolName} is unavailable in this evaluation`};
  });
}
