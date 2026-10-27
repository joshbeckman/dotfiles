// Not a test: `node test/browser/palette-shots.ts DIR` seeds a domain and saves the command
// palette's screenshots to DIR/palette-<name>.png, for reviewing UX-15.

import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { loopbackOrigin } from "../../src/web/static.ts";
import { closePage, evaluatePage, newPage, resizePage, screenshot, selectPage } from "./cli.ts";
import { seedDomain } from "./seed.ts";

const dir = process.argv[2] ?? "";
if (!dir) throw new Error("usage: node test/browser/palette-shots.ts DIR");

/**
 * Every session on this machine drives one chrome-devtools daemon, and another session's
 * `new_page` takes the selection away mid-suite, so each call names this page again and checks
 * it is really the one that answered.
 */
async function onthis<T>(body: string, timeoutMs = 90_000): Promise<T> {
	const end = Date.now() + timeoutMs;
	let last: unknown;
	while (Date.now() < end) {
		await selectPage(page);
		const host = await evaluatePage<string>(`return location.host;`).catch(() => "");
		if (host !== myHost) {
			await sleep(120);
			continue;
		}
		try {
			return await evaluatePage<T>(body);
		} catch (error) {
			// The selection moved between the check and the call: try again on this page.
			last = error;
			console.error(`retry on ${myHost}: ${String(error).split("\n")[0]}`);
			await sleep(120);
		}
	}
	throw last ?? new Error(`could not keep ${myHost} selected`);
}

/** A screenshot of this page, retaken if the selection moved while it was captured. */
async function capture(): Promise<string> {
	for (let attempt = 0; attempt < 40; attempt++) {
		await selectPage(page);
		const before = await evaluatePage<string>(`return location.host;`).catch(() => "");
		if (before !== myHost) {
			await sleep(120);
			continue;
		}
		const file = await screenshot(true);
		const after = await evaluatePage<string>(`return location.host;`).catch(() => "");
		if (after === myHost) return file;
		console.error(`retaking ${file}: the selection moved`);
	}
	throw new Error("could not screenshot this page");
}

const KEYS = `
	const press = async (key, init = {}) => {
		const target = document.activeElement && document.activeElement !== document.body ? document.activeElement : document.body;
		target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
		await sleep(40);
	};
	const chord = () => (window.__pana.state.apple ? { metaKey: true } : { ctrlKey: true });
	const open = () => !document.getElementById("palette").hidden;
	/** Leave the palette in a known state, so a retried body does not toggle it shut again. */
	const settled = async () => {
		while (open()) await press("Escape");
		document.activeElement?.blur();
	};
	const opened = async () => {
		await settled();
		await press("k", chord());
		await until(open, 5000);
	};
`;

const seeded = await seedDomain();
const { t } = seeded;
const origin = loopbackOrigin(t.panad.tcpPort!);
const page = await newPage(`${origin}/#${t.panad.webToken}`);
const myHost = new URL(origin).host;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function shot(name: string, body: string): Promise<void> {
	console.error(`shot ${name}`);
	await onthis(`
		${KEYS}
		${body}
		await sleep(400);
		return true;
	`);
	const file = await capture();
	const target = join(dir, `palette-${name}.png`);
	copyFileSync(file, target);
	console.log(target);
}

try {
	await selectPage(page);
	await resizePage(1280, 900);
	await onthis(`await until(() => document.querySelectorAll("#inbox-list .item").length >= 3); return true;`);

	await shot("commands", `await opened();`);
	await shot(
		"filtered",
		`await opened();
		 const input = document.getElementById("palette-input");
		 input.value = "thr";
		 input.dispatchEvent(new Event("input", { bubbles: true }));
		 await sleep(80);`,
	);
	await shot(
		"search",
		`await opened();
		 const input = document.getElementById("palette-input");
		 input.value = "search";
		 input.dispatchEvent(new Event("input", { bubbles: true }));
		 await sleep(80);
		 await press("Enter");
		 await until(() => document.activeElement?.id === "palette-search-input", 5000);
		 const search = document.getElementById("palette-search-input");
		 search.value = "Paris";
		 search.dispatchEvent(new Event("input", { bubbles: true }));
		 await until(() => document.querySelectorAll("#palette-list [data-testid=palette-hit]").length >= 2, 5000);`,
	);

	await onthis(`${KEYS} await settled(); return true;`);
	await resizePage(390, 844);
	await shot(
		"phone",
		`location.hash = "#/inbox";
		 await until(() => window.__pana.state.section === "inbox");
		 await sleep(200);`,
	);
	await shot(
		"phone-open",
		`document.getElementById("open-palette").click();
		 await until(open);`,
	);
} finally {
	await resizePage(1280, 900);
	await closePage(page);
	await t.close();
}
