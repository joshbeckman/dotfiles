import { spawnSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

const GIT_COMMIT_RE = /\b(?:command\s+)?git\s+(commit|c|ci|cm)\b/;
const GT_COMMIT_RE = /\bgt\s+(commit\s+create|commit\s+amend|create|modify|cc|ca|c|m)\b/;
const FALLBACK_EMAIL = "josh+pi@joshbeckman.org";

export function buildTrailer(cwd: string): string {
	const email = gitEmail(cwd) || FALLBACK_EMAIL;
	return `Co-authored-by: Josh's Pi Agent <${piEmail(email)}>`;
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return undefined;

		const cmd = event.input.command;
		if (!cmd) return undefined;
		if (cmd.includes("PI_DISABLE_COAUTHOR")) return undefined;
		if (hasCoAuthoredBy(cmd)) return undefined;

		const isGit = containsUnquoted(cmd, GIT_COMMIT_RE);
		const isGt = containsUnquoted(cmd, GT_COMMIT_RE);
		if (!isGit && !isGt) return undefined;
		if (isGt && /(?:^|\s)--ai(?:\s|$)/.test(cmd)) return undefined;
		if (isGit && cmd.includes("--amend") && cmd.includes("--no-edit") && !cmd.includes("-m")) return undefined;

		const trailer = buildTrailer(ctx.cwd);
		event.input.command = isGit ? injectGitTrailer(cmd, trailer) : injectGtTrailer(cmd, trailer);
		return undefined;
	});
}

export function hasCoAuthoredBy(cmd: string): boolean {
	return /co-authored-by:/i.test(cmd);
}

export function injectGitTrailer(cmd: string, trailer: string): string {
	const parts = splitShellCommand(cmd);

	for (let i = 0; i < parts.length; i += 2) {
		if (containsUnquoted(parts[i], GIT_COMMIT_RE)) {
			parts[i] = `${parts[i].trimEnd()} --trailer ${shellQuote(trailer)}`;
			return parts.join("");
		}
	}

	return parts.join("");
}

export function injectGtTrailer(cmd: string, trailer: string): string {
	const parts = splitShellCommand(cmd);

	for (let i = 0; i < parts.length; i += 2) {
		if (containsUnquoted(parts[i], GT_COMMIT_RE)) {
			parts[i] = appendTrailerToMessage(parts[i], trailer);
			return parts.join("");
		}
	}

	return parts.join("");
}

export function appendTrailerToMessage(segment: string, trailer: string): string {
	const re = /(-m|--message)\s+(["'])((?:(?!\2).)*)\2/s;
	const match = segment.match(re);
	if (!match) return segment;

	const flag = match[1];
	const quote = match[2];
	const message = match[3];
	const escapedTrailer = quote === '"' ? trailer.replace(/\\/g, "\\\\").replace(/"/g, '\\"') : trailer.replace(/'/g, "'\\''");
	return segment.replace(re, `${flag} ${quote}${message}\n\n${escapedTrailer}${quote}`);
}

export function splitShellCommand(cmd: string): string[] {
	const parts: string[] = [];
	let segmentStart = 0;
	let i = 0;
	let quote: '"' | "'" | undefined;
	const isWhitespace = (char: string | undefined) => char !== undefined && /\s/.test(char);

	while (i < cmd.length) {
		const char = cmd[i];

		if (quote) {
			if (quote === '"' && char === "\\" && i + 1 < cmd.length) {
				i += 2;
				continue;
			}
			if (char === quote) quote = undefined;
			i += 1;
			continue;
		}

		if (char === '"' || char === "'") {
			quote = char;
			i += 1;
			continue;
		}

		let operatorLength = 0;
		if ((char === "&" && cmd[i + 1] === "&") || (char === "|" && cmd[i + 1] === "|")) {
			operatorLength = 2;
		} else if (char === ";" || char === "\n" || char === "|") {
			operatorLength = 1;
		}

		if (operatorLength > 0) {
			let separatorStart = i;
			while (separatorStart > segmentStart && isWhitespace(cmd[separatorStart - 1])) separatorStart -= 1;
			let separatorEnd = i + operatorLength;
			while (separatorEnd < cmd.length && isWhitespace(cmd[separatorEnd])) separatorEnd += 1;

			parts.push(cmd.slice(segmentStart, separatorStart));
			parts.push(cmd.slice(separatorStart, separatorEnd));
			segmentStart = separatorEnd;
			i = separatorEnd;
			continue;
		}

		i += 1;
	}

	parts.push(cmd.slice(segmentStart));
	return parts;
}

export function containsUnquoted(text: string, re: RegExp): boolean {
	const quotedRanges: Array<[number, number]> = [];
	let quote: '"' | "'" | undefined;
	let quoteStart = -1;

	for (let i = 0; i < text.length; i += 1) {
		const char = text[i];
		if (quote) {
			if (quote === '"' && char === "\\" && i + 1 < text.length) {
				i += 1;
				continue;
			}
			if (char === quote) {
				quotedRanges.push([quoteStart, i + 1]);
				quote = undefined;
				quoteStart = -1;
			}
		} else if (char === '"' || char === "'") {
			quote = char;
			quoteStart = i;
		}
	}
	if (quote && quoteStart >= 0) quotedRanges.push([quoteStart, text.length]);

	const globalRe = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
	for (let match = globalRe.exec(text); match !== null; match = globalRe.exec(text)) {
		const start = match.index;
		const end = start + match[0].length;
		if (!quotedRanges.some(([quotedStart, quotedEnd]) => start < quotedEnd && end > quotedStart)) return true;
		if (match[0].length === 0) globalRe.lastIndex += 1;
	}
	return false;
}

function gitEmail(cwd: string): string | undefined {
	const result = spawnSync("git", ["config", "user.email"], { cwd, encoding: "utf8" });
	if (result.status !== 0) return undefined;
	const email = result.stdout.trim();
	return email.includes("@") ? email : undefined;
}

function piEmail(email: string): string {
	const at = email.lastIndexOf("@");
	if (at === -1) return email;
	return `${email.slice(0, at)}+pi${email.slice(at)}`;
}

function shellQuote(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
