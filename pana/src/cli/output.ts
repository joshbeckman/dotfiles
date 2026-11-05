// Output rendering (CLI-03): JSON when stdout is not a TTY or `--json` is given, text when it
// is. Text is one block per record: `key: value` lines, nested records indented, arrays as `-`
// items. A record with one of a few single string fields renders as just its value, so
// `pana memory` prints the worktree path alone.
//
// Every string here came from the daemon, so every string is untrusted: a message body or a
// schedule label may carry an escape sequence meant for the terminal reading it (CLI-08). Text
// goes through `sanitizeTerminalText`, and JSON through `escapeJsonControls`, so neither surface
// can act on the terminal it is printed to.

import { escapeJsonControls, sanitizeTerminalText } from "./sanitize.ts";

export function renderJson(value: unknown): string {
	if (value === undefined) return "";
	return `${escapeJsonControls(JSON.stringify(value, null, 2))}\n`;
}

export function renderText(value: unknown): string {
	if (value === undefined || value === null) return "";
	if (Array.isArray(value)) {
		const blocks = value.map((item) => renderRecord(item)).filter((block) => block.length > 0);
		return blocks.length === 0 ? "" : `${blocks.join("\n\n")}\n`;
	}
	const single = singleString(value);
	if (single !== undefined) return `${single}\n`;
	const block = renderRecord(value);
	return block.length === 0 ? "" : `${block}\n`;
}

function singleString(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const entries = Object.entries(value);
	if (entries.length !== 1) return undefined;
	const [key, field] = entries[0]!;
	// A single text field renders as just its text, so `pana memory` and `pana objective brief`
	// print their document and nothing else.
	return typeof field === "string" && (key === "path" || key === "url" || key === "body" || key === "brief")
		? sanitizeTerminalText(field)
		: undefined;
}

function renderRecord(value: unknown, indent = ""): string {
	if (value === null || value === undefined) return "";
	if (typeof value !== "object") return `${indent}${inline(value)}`;
	const lines: string[] = [];
	for (const [key, field] of Object.entries(value as Record<string, unknown>)) {
		if (Array.isArray(field) && field.some((item) => item !== null && typeof item === "object")) {
			lines.push(`${indent}${key}:`);
			for (const item of field) {
				const [first = "", ...rest] = renderRecord(item, `${indent}    `).split("\n");
				lines.push(`${indent}  - ${first.trimStart()}`, ...rest);
			}
			continue;
		}
		if (field !== null && typeof field === "object" && !Array.isArray(field)) {
			lines.push(`${indent}${key}:`);
			lines.push(renderRecord(field, `${indent}  `));
			continue;
		}
		lines.push(`${indent}${key}: ${inline(field)}`);
	}
	return lines.filter((line) => line.trim().length > 0).join("\n");
}

function inline(value: unknown): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "string") return sanitizeTerminalText(value);
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return JSON.stringify(value);
}
