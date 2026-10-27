// Drive the installed Chrome through the chrome-devtools CLI (see
// `.agents/skills/browser-testing/SKILL.md`). No browser download: the CLI uses the Chrome on
// this machine, and the daemon persists between commands.

import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export function chromeDevtoolsAvailable(): boolean {
	try {
		execFileSync("sh", ["-c", "command -v chrome-devtools"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
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
	return selected.id;
}

export async function closePage(id: number): Promise<void> {
	await command(["close_page", String(id)]).catch(() => undefined);
}

/**
 * Save a screenshot of the selected page and return the file it landed in. The installed CLI
 * refuses `--filePath` outside its workspace roots, so it always writes under the OS temp
 * directory; callers copy the file where they want it.
 */
export async function screenshot(fullPage = false): Promise<string> {
	const result = (await command(["take_screenshot", ...(fullPage ? ["--fullPage", "true"] : [])])) as
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
	await command(["emulate", "--viewport", viewport, ...(colorScheme ? ["--colorScheme", colorScheme] : [])]);
}

export async function emulateColorScheme(scheme: "dark" | "light" | "auto"): Promise<void> {
	await command(["emulate", "--colorScheme", scheme]);
}

export async function resizePage(width: number, height: number): Promise<void> {
	await command(["resize_page", String(width), String(height)]);
}

/** Evaluate an async function source in the page and return its JSON value. */
export async function evaluate<T>(source: string): Promise<T> {
	const result = (await command(["evaluate_script", source])) as
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
