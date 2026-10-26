// Argument parsing (CLI-04, CLI-07): global flags anywhere, the command path first, then that
// command's flags and positionals in any order. An unknown flag or a wrong argument count is a
// usage error, and the CLI exits 2.

import type { CommandSpec, FlagSpec, Flags } from "./commands.ts";

/** A problem with how the command was invoked. The CLI prints the usage line and exits 2. */
export class UsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UsageError";
	}
}

/** Flags that need no command context and may appear anywhere. */
export const GLOBAL_FLAGS: ReadonlySet<string> = new Set(["--json", "--help", "-h"]);

export interface ParsedFlag {
	/** Canonical name, e.g. `body-file`. */
	name: string;
	value: string | true;
}

export interface ParsedArgv {
	path: string[];
	flags: ParsedFlag[];
	positionals: string[];
	json: boolean;
	help: boolean;
}

function specForFlag(specs: readonly FlagSpec[], written: string): FlagSpec | undefined {
	return specs.find((spec) => spec.syntax.split(" ")[0] === written);
}

function isCommandStart(commands: readonly CommandSpec[], candidate: readonly string[]): boolean {
	const key = candidate.join(" ");
	return commands.some((command) => {
		const commandPath = command.path.join(" ");
		return commandPath === key || commandPath.startsWith(`${key} `);
	});
}

/**
 * Split argv into the command path, flags, and positionals. `--json`, `--help`, and `-h` are
 * global and are removed first, so they may sit anywhere (`pana --json thread read X`).
 */
export function parseArgv(argv: readonly string[], commands: readonly CommandSpec[]): ParsedArgv {
	const json = argv.includes("--json");
	const help = argv.includes("--help") || argv.includes("-h");
	const rest = argv.filter((token) => !GLOBAL_FLAGS.has(token));

	const path: string[] = [];
	let index = 0;
	while (index < rest.length) {
		const token = rest[index]!;
		if (token.startsWith("-") && token !== "-") break;
		const candidate = [...path, token];
		if (!isCommandStart(commands, candidate)) break;
		path.push(token);
		index++;
	}

	const command = commands.find((candidate) => candidate.path.join(" ") === path.join(" "));
	const parsed = parseRest(rest.slice(index), command?.flags ?? []);
	return { path, json, help, ...parsed };
}

function parseRest(
	tokens: readonly string[],
	specs: readonly FlagSpec[],
): { flags: ParsedFlag[]; positionals: string[] } {
	const flags: ParsedFlag[] = [];
	const positionals: string[] = [];
	let index = 0;
	while (index < tokens.length) {
		const token = tokens[index]!;
		if (token === "--") {
			positionals.push(...tokens.slice(index + 1));
			break;
		}
		if (!token.startsWith("-") || token === "-") {
			positionals.push(token);
			index++;
			continue;
		}
		const equals = token.indexOf("=");
		const written = equals === -1 ? token : token.slice(0, equals);
		const inline = equals === -1 ? undefined : token.slice(equals + 1);
		const spec = specForFlag(specs, written);
		if (!spec) throw new UsageError(`unknown flag ${written}`);
		if (spec.type === "boolean") {
			if (inline !== undefined) throw new UsageError(`${spec.syntax} takes no value`);
			flags.push({ name: spec.name, value: true });
			index++;
			continue;
		}
		if (inline !== undefined) {
			flags.push({ name: spec.name, value: inline });
			index++;
			continue;
		}
		const value = tokens[index + 1];
		if (value === undefined) throw new UsageError(`missing value for ${spec.syntax}`);
		flags.push({ name: spec.name, value });
		index += 2;
	}
	return { flags, positionals };
}

/** Collect parsed flags against the command's specs, and require the required ones. */
export function resolveFlags(command: CommandSpec, parsed: readonly ParsedFlag[]): Flags {
	const values = new Map<string, string | true | string[]>();
	for (const { name, value } of parsed) {
		const spec = command.flags.find((candidate) => candidate.name === name);
		if (!spec) throw new UsageError(`unknown flag --${name}`);
		if (spec.type === "list") {
			const current = values.get(name);
			const items = Array.isArray(current) ? current : [];
			items.push(String(value));
			values.set(name, items);
		} else {
			values.set(name, value);
		}
	}
	for (const spec of command.flags) {
		if (spec.required && !values.has(spec.name)) throw new UsageError(`missing required flag ${spec.syntax}`);
	}
	return {
		has: (name) => values.has(name),
		get: (name) => {
			const value = values.get(name);
			if (value === undefined) return undefined;
			return Array.isArray(value) ? value.at(-1) : String(value);
		},
		list: (name) => {
			const value = values.get(name);
			if (Array.isArray(value)) return value;
			if (value === undefined) return [];
			return [String(value)];
		},
	};
}

/** Check the positional count against the command's spec. */
export function resolvePositionals(command: CommandSpec, given: readonly string[]): string[] {
	const required = command.positionals.filter((spec) => spec.required).length;
	if (given.length < required) {
		throw new UsageError(`missing ${command.positionals[given.length]!.name}`);
	}
	if (given.length > command.positionals.length) {
		throw new UsageError(`unexpected argument ${given[command.positionals.length]}`);
	}
	return [...given];
}
