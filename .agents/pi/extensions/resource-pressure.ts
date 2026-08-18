import { execFileSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type MemoryPressureLevel = 1 | 2 | 4;

type PressureAction = "warn" | "block" | undefined;

export function parseMemoryPressureLevel(value: string): MemoryPressureLevel | undefined {
	const level = Number(value.trim());
	return level === 1 || level === 2 || level === 4 ? level : undefined;
}

export function memoryPressureLevel(): MemoryPressureLevel | undefined {
	if (process.platform !== "darwin") return undefined;
	try {
		return parseMemoryPressureLevel(
			execFileSync("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				timeout: 1_000,
			}),
		);
	} catch {
		return undefined;
	}
}

export function pressureAction(toolName: string, level: MemoryPressureLevel | undefined): PressureAction {
	if (toolName === "subagent" && (level === 2 || level === 4)) return "block";
	if (toolName === "bg_run" && level === 4) return "block";
	if (toolName === "bg_run" && level === 2) return "warn";
	return undefined;
}

export function shouldSuppressMailWake(level: MemoryPressureLevel | undefined): boolean {
	return level === 4;
}

export default function (pi: ExtensionAPI) {
	const warnedBgRuns = new Set<string>();

	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== "subagent" && event.toolName !== "bg_run") return undefined;

		const level = memoryPressureLevel();
		const action = pressureAction(event.toolName, level);
		if (!action || !level) return undefined;

		const state = level === 4 ? "critical" : "warning";
		if (action === "warn") {
			warnedBgRuns.add(event.toolCallId);
			if (ctx.hasUI) {
				ctx.ui.notify(`Memory pressure is ${state} (${level}); allowing bg_run, but avoid additional fanout`, "warning");
			}
			return undefined;
		}

		return {
			block: true,
			reason: `${event.toolName} deferred because system memory pressure is ${state} (${level}). Continue locally or retry when pressure returns to normal (1).`,
		};
	});

	pi.on("tool_result", (event) => {
		if (!warnedBgRuns.delete(event.toolCallId)) return undefined;
		return {
			content: [
				...event.content,
				{
					type: "text",
					text: "Memory pressure was warning (2) when this background job started. Avoid additional fanout until it returns to normal (1).",
				},
			],
		};
	});
}
