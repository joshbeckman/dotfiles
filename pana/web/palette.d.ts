// Types for the browser module `palette.js`, which Node tests import directly.

export interface CommandContext {
	thread?: unknown;
	session?: unknown;
	selection?: unknown;
	push?: { subscribed?: boolean };
}

export interface Command {
	id: string;
	label: string;
	hint?: string;
	keywords?: string;
	when?: (context: CommandContext) => boolean;
}

export interface Hit {
	kind: "thread" | "session" | "memory";
	id: string;
	label: string;
	meta?: string;
	at?: number;
}

export interface HitGroup {
	title: string;
	hits: Hit[];
}

export interface Ranked<T> {
	item: T;
	score: number | null;
}

export const HITS_PER_STORE: number;
export const COMMANDS: Command[];
export function paletteCommands(context?: CommandContext): Command[];
export function fuzzyScore(text: unknown, query: unknown): number | null;
export function rankBy<T>(items: T[], query: unknown, text?: (item: T) => string, options?: { keep?: boolean }): Ranked<T>[];
export function matchCommands(commands: Command[], query: string): Command[];
export function threadHits(body: unknown): Hit[];
export function sessionHits(body: unknown): Hit[];
export function memoryHits(body: unknown): Hit[];
export function paletteHits(
	bodies: { threads?: unknown; sessions?: unknown; memory?: unknown } | undefined,
	query: string,
	limit?: number,
): HitGroup[];
export function hitHash(hit: Pick<Hit, "kind" | "id">): string;
