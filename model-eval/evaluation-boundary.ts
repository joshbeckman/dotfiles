import {appendFileSync, lstatSync, realpathSync} from "node:fs";
import {dirname, isAbsolute, relative, resolve, sep} from "node:path";
import type {ExtensionAPI} from "@earendil-works/pi-coding-agent";

const root = realpathSync(process.env.PI_EVAL_ROOT ?? process.cwd());
const allowedCommands = new Set<string>(JSON.parse(process.env.PI_EVAL_ALLOWED_COMMANDS ?? "[]"));
const allowedCommandPrefixes: string[] = JSON.parse(process.env.PI_EVAL_ALLOWED_COMMAND_PREFIXES ?? "[]");
const commandTimeout = Number(process.env.PI_EVAL_COMMAND_TIMEOUT ?? "10");
// The bash wrapper runs under `env -i`, so a fixture's policy environment has to be passed in here
// rather than inherited. Keys and values are fixture-authored, not model-authored.
const commandEnv: Record<string, string> = JSON.parse(process.env.PI_EVAL_COMMAND_ENV ?? "{}");
const commandEnvPrefix = Object.entries(commandEnv)
  .map(([key, value]) => `${key}=${`'${String(value).replaceAll("'", "'\\''")}'`}`)
  .join(" ");
function optionalRealpath(path: string | undefined): string | undefined {
  try {
    return path ? realpathSync(path) : undefined;
  } catch {
    return undefined;
  }
}
const configRoot = optionalRealpath(process.env.PI_EVAL_CONFIG_ROOT);
const explicitSkillRoots = (JSON.parse(process.env.PI_EVAL_SKILL_ROOTS ?? "[]") as string[])
  .map(optionalRealpath).filter((path): path is string => Boolean(path));

function insideConfiguredSkill(path: string): boolean {
  try {
    const candidate = realpathSync(path);
    if (explicitSkillRoots.some((root) => candidate === root || candidate.startsWith(root + sep))) return true;
    if (!configRoot || (candidate !== configRoot && !candidate.startsWith(configRoot + sep))) return false;
    return relative(configRoot, candidate).split(sep).includes("skills");
  } catch {
    return false;
  }
}

function insideRoot(path: string, writing = false): boolean {
  try {
    const candidate = resolve(root, path.replace(/^@/, ""));
    // lstat sees the final component without following it, so a dangling symlink is still a
    // symlink here; existsSync followed the link and let a write through it.
    const entry = lstatSync(candidate, {throwIfNoEntry: false});
    if (entry?.isSymbolicLink()) return false;
    const checked = realpathSync(entry ? candidate : writing ? dirname(candidate) : candidate);
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
      if (event.toolName === "read" && isAbsolute(path) && insideConfiguredSkill(path)) return;
      if (!path || isAbsolute(path) || !insideRoot(path, event.toolName === "write")) {
        return {block: true, reason: `${event.toolName} is restricted to files inside the fixture workspace`};
      }
      return;
    }

    if (event.toolName === "bash") {
      const command = typeof input.command === "string" ? input.command : "";
      // A prefix match must stay one plain command: no chaining, redirection, substitution, or
      // leading environment assignment that could rewrite what a fixture's stub reads.
      const chained = /[;&|<>`$\n]/.test(command) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(command);
      const prefixed = allowedCommandPrefixes.some((prefix) => prefix.length > 0 && command.startsWith(prefix));
      const permitted = allowedCommands.has(command) || (prefixed && !chained);
      // A refused command is invisible in the redacted event log, so keep the attempt on disk.
      try {
        appendFileSync(`${root}/.bash.tsv`, `${permitted ? "allowed" : "refused"}\t${command.replaceAll("\n", " ").slice(0, 400)}\n`);
      } catch {
        // Diagnostics must not change the outcome of the call.
      }
      if (!permitted) {
        return {block: true, reason: "This fixture does not allow that shell command"};
      }
      input.timeout = Math.min(Number(input.timeout ?? commandTimeout), commandTimeout);
      const policy = commandEnvPrefix ? `${commandEnvPrefix} ` : "";
      input.command = `/usr/bin/env -i HOME="$PI_EVAL_ROOT" TMPDIR="$PI_EVAL_ROOT" PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" PYTHONDONTWRITEBYTECODE=1 ${policy}${command}`;
      return;
    }

    return {block: true, reason: `Tool ${event.toolName} is unavailable in this evaluation`};
  });
}
