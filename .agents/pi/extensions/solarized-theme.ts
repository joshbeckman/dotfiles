import { execFileSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const LIGHT_THEME = "solarized-light";
const DARK_THEME = "solarized-dark";

export default function (pi: ExtensionAPI) {
	let interval: ReturnType<typeof setInterval> | undefined;
	let currentTheme: string | undefined;

	pi.on("session_start", (_event, ctx) => {
		const apply = () => {
			const nextTheme = macOsDarkMode() ? DARK_THEME : LIGHT_THEME;
			if (nextTheme === currentTheme) return;
			currentTheme = nextTheme;
			ctx.ui.setTheme(nextTheme);
		};

		apply();
		interval = setInterval(apply, 30_000);
	});

	pi.on("session_shutdown", () => {
		if (!interval) return;
		clearInterval(interval);
		interval = undefined;
	});
}

function macOsDarkMode(): boolean {
	try {
		const output = execFileSync("defaults", ["read", "-g", "AppleInterfaceStyle"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return output.toLowerCase() === "dark";
	} catch {
		return false;
	}
}
