// Types for the browser module `keys.js`, which Node tests import directly.

export interface Binding {
	action: string;
	sequences: string[][];
	description: string;
}

export interface KeyLike {
	key: string;
	metaKey?: boolean;
	ctrlKey?: boolean;
	altKey?: boolean;
	shiftKey?: boolean;
	timeStamp?: number;
}

export interface KeyContext {
	inInput?: boolean;
	inForm?: boolean;
	apple?: boolean;
}

export interface HelpRow {
	scope: "page" | "input";
	action: string;
	keys: string[];
	description: string;
}

export interface KeyReader {
	readonly pending: string[];
	reset(): void;
	press(event: KeyLike, context?: KeyContext): string | null;
}

export const KEYMAP: Binding[];
export const INPUT_KEYMAP: Binding[];
export const SEQUENCE_TIMEOUT: number;
export function isTextInput(element: { tagName?: string; type?: string; isContentEditable?: boolean } | null | undefined): boolean;
export function isApplePlatform(platform: string | undefined): boolean;
export function isSubmitChord(event: KeyLike, apple: boolean): boolean;
export function sequenceLabel(sequence: string[], apple: boolean): string;
export function helpRows(apple: boolean): HelpRow[];
export function createKeyReader(options?: { keymap?: Binding[]; timeout?: number }): KeyReader;
export function moveSelection(index: number, count: number, action: string): number;
