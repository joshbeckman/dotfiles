// Help text (CLI-06): `pana --help` lists every command in README.md, `pana <noun> --help`
// lists that noun's commands, and `pana <command> --help` lists its flags.

import type { CommandSpec } from "./commands.ts";

const ROOT_USAGE = "Usage: pana <noun> <command> [options]";

function words(path: readonly string[]): string {
	return path[0] ?? "";
}

function nouns(commands: readonly CommandSpec[]): string[] {
	const seen: string[] = [];
	for (const command of commands) {
		const noun = words(command.path);
		if (!seen.includes(noun)) seen.push(noun);
	}
	return seen;
}

function flagLines(flags: CommandSpec["flags"]): string[] {
	if (flags.length === 0) return [];
	const width = Math.max(...flags.map((flag) => flag.syntax.length));
	return [
		"",
		"Flags:",
		...flags.map((flag) => `  ${flag.syntax.padEnd(width)}  ${flag.description}`),
	];
}

/** Render help for a path: empty for the root, a command for a leaf, a noun otherwise. */
export function renderHelp(commands: readonly CommandSpec[], path: readonly string[]): string {
	if (path.length === 0) {
		const lines = [ROOT_USAGE, "", "Commands:"];
		const groups = nouns(commands);
		const width = Math.max(...groups.map((noun) => noun.length));
		for (const noun of groups) {
			const group = commands.filter((command) => words(command.path) === noun);
			lines.push("", `${noun.padEnd(width)}  ${group[0]!.summary}`);
			for (const command of group) {
				for (const usage of [command.usage, ...(command.altUsage ?? [])]) lines.push(`  ${usage}`);
			}
		}
		lines.push(
			"",
			"Global flags:",
			"  --json  Print JSON even on a terminal",
			"  --help  Show this help",
			"",
			"Run `pana <noun> --help` for one noun, or `pana <command> --help` for one command's flags.",
		);
		return `${lines.join("\n")}\n`;
	}

	const prefix = path.join(" ");
	const command = commands.find((candidate) => candidate.path.join(" ") === prefix);
	const hasChildren = commands.some((candidate) => candidate.path.join(" ").startsWith(`${prefix} `));
	if (command && !hasChildren) {
		const lines = [command.usage, "", command.summary];
		if (command.needsBody) {
			lines.push("", "Give the body with one of --body TEXT, --body-file PATH, or --body -.");
		}
		lines.push(...flagLines(command.flags));
		return `${lines.join("\n")}\n`;
	}

	const group = commands.filter(
		(candidate) => candidate.path.join(" ") === prefix || candidate.path.join(" ").startsWith(`${prefix} `),
	);
	const noun = path.at(-1)!;
	const lines = [`Usage: pana ${prefix} [<command>] [options]`, "", `Commands for ${noun}:`];
	for (const candidate of group) {
		for (const usage of [candidate.usage, ...(candidate.altUsage ?? [])]) lines.push("", usage);
		lines.push(`  ${candidate.summary}`);
	}
	lines.push("", "Global flags:", "  --json  Print JSON even on a terminal", "  --help  Show this help");
	return `${lines.join("\n")}\n`;
}
