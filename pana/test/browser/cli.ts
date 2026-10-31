// Drive the installed Chrome through the chrome-devtools CLI (see
// `.agents/skills/browser-testing/SKILL.md`). No browser download: the CLI uses the Chrome on
// this machine, and the daemon persists between commands.
//
// chrome-devtools-mcp 1.10 takes the page a command acts on as a positional argument, and stops
// with "Not enough non-option arguments: got 0, need at least 1" without it (1.6 only had a
// `selectPage` that a later commit removed). So every command here names its page. Each suite
// drives one page at a time, the one `newPage` opened, and these helpers remember it as `current`
// rather than threading it through every call site. `evaluate_script`'s page is optional, so it
// gets `--pageId` when there is one.

import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** The page the commands here act on: the one `newPage` opened and `closePage` has not closed. */
let current: number | undefined;

export function chromeDevtoolsAvailable(): boolean {
	try {
		execFileSync("sh", ["-c", "command -v chrome-devtools"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

/** The page a command must name. A suite that has opened none has nothing to act on. */
function pageId(): number {
	if (current === undefined) throw new Error("no page: open one with newPage() first");
	return current;
}

function parseOutput(stdout: string): unknown {
	const text = stdout.trim();
	if (!text) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		// The CLI prints a banner on some versions; use the last JSON line.
	}
	const lines = text.split("\n");
	for (let index = lines.length - 1; index >= 0; index--) {
		const line = lines[index]!.trim();
		if (!line.startsWith("{") && !line.startsWith("[")) continue;
		try {
			return JSON.parse(line);
		} catch {
			// Keep looking.
		}
	}
	return undefined;
}

async function command(args: string[]): Promise<unknown> {
	const { stdout } = await run("chrome-devtools", [...args, "--output-format=json"], {
		maxBuffer: 64 * 1024 * 1024,
		timeout: 120_000,
	});
	return parseOutput(stdout);
}

interface PageList {
	pages?: Array<{ id: number; selected?: boolean; url?: string }>;
}

export async function newPage(url: string): Promise<number> {
	const result = (await command(["new_page", url])) as PageList;
	const pages = result?.pages ?? [];
	const selected = pages.find((page) => page.selected) ?? pages[pages.length - 1];
	if (!selected) throw new Error(`could not open ${url}`);
	current = selected.id;
	return selected.id;
}

export async function closePage(id: number): Promise<void> {
	if (current === id) current = undefined;
	await command(["close_page", String(id)]).catch(() => undefined);
}

/**
 * Save a screenshot of `page` and return the file it landed in. The installed CLI refuses
 * `--filePath` outside its workspace roots, so it always writes under the OS temp directory;
 * callers copy the file where they want it.
 */
export async function screenshot(fullPage = false): Promise<string> {
	const result = (await command(["take_screenshot", String(pageId()), ...(fullPage ? ["--fullPage"] : [])])) as
		| { images?: Array<{ filePath?: string }> }
		| Array<{ images?: Array<{ filePath?: string }> }>
		| undefined;
	const images = Array.isArray(result) ? result[0]?.images : result?.images;
	const file = images?.[0]?.filePath;
	if (!file) throw new Error("take_screenshot answered without a file");
	return file;
}

/** Emulate a phone: `viewport` is `WIDTHxHEIGHTxDPR[,mobile][,touch]`, or "" to clear. */
export async function emulateViewport(viewport: string, colorScheme?: "dark" | "light" | "auto"): Promise<void> {
	await command(["emulate", String(pageId()), "--viewport", viewport, ...(colorScheme ? ["--colorScheme", colorScheme] : [])]);
}

export async function emulateColorScheme(scheme: "dark" | "light" | "auto"): Promise<void> {
	await command(["emulate", String(pageId()), "--colorScheme", scheme]);
}

export async function resizePage(width: number, height: number): Promise<void> {
	await command(["resize_page", String(pageId()), String(width), String(height)]);
}

/** Evaluate an async function source in the page and return its JSON value. */
export async function evaluate<T>(source: string): Promise<T> {
	const page = current === undefined ? [] : ["--pageId", String(current)];
	const result = (await command(["evaluate_script", ...page, source])) as
		| { message?: string }
		| Array<{ type?: string; text?: string }>
		| undefined;
	const text = Array.isArray(result) ? (result[0]?.text ?? "") : (result?.message ?? "");
	if (/^Error:/m.test(text)) throw new Error(text);
	const fenced = /```json\n([\s\S]*?)\n```/.exec(text);
	const payload = fenced ? fenced[1]! : text.replace(/^Script ran on page and returned:\s*/, "").trim();
	try {
		return JSON.parse(payload) as T;
	} catch {
		return payload as T;
	}
}

/** Evaluate a body inside an async arrow, with small polling helpers in scope. */
export async function evaluatePage<T>(body: string): Promise<T> {
	return evaluate<T>(`async () => {
		const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
		const until = async (check, timeout = 20000) => {
			const end = Date.now() + timeout;
			for (;;) {
				const value = await check();
				if (value) return value;
				if (Date.now() > end) throw new Error("timed out waiting for the page");
				await sleep(50);
			}
		};
		${body}
	}`);
}
