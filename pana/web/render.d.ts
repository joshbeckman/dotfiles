// Types for the browser module `render.js`, which Node tests import directly.

import type { Choice } from "./choices.js";
export type { Choice } from "./choices.js";

export interface RenderOptions {
	marked?: unknown;
	DOMPurify?: unknown;
	domain?: string;
	fetchFile?: (path: string) => Promise<Blob>;
	cache?: Map<string, Promise<string>>;
	ensureMermaid?: () => Promise<unknown>;
	fetchMargin?: string;
	idPrefix?: string;
	dark?: boolean;
	onPick?: (option: Choice, button: unknown, group: unknown) => void;
	/** Where a diagram failure is logged. Defaults to `console.error`. */
	report?: (failure: unknown) => void;
	timeoutMs?: number;
}

export const CHOICES_LANGUAGE: string;

export function parseChoices(text: string | null | undefined): Choice[] | null;
export function renderChoices(root: unknown, options?: { onPick?: RenderOptions["onPick"] }): number;
export function syncChoices(root: unknown, has: (reply: string) => boolean): void;

export function markdownToHtml(text: string, options: RenderOptions): string;
export function escapeHtml(value: unknown): string;
export function rewriteLinks(root: unknown, domain?: string): unknown;
export function linkifyTextNodes(root: unknown, domain?: string): unknown;
export function hydrateFiles(root: unknown, fetchFile: unknown, options?: Record<string, unknown>): Promise<void>;
export function renderDiagrams(root: unknown, options?: RenderOptions): Promise<number>;
export const DIAGRAM_NOTES: { unavailable: string; failed: string; timedOut: (ms: number) => string };
export const DIAGRAM_TIMEOUT_MS: number;
export function renderMessage(target: unknown, text: string, options: RenderOptions): Promise<unknown>;
