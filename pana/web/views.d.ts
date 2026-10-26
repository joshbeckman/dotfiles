// Types for the browser module `views.js`, which Node tests import directly.

export interface EntryUsage {
	input: number;
	output: number;
	costUsd: number;
}

export type EntryBlock =
	| { type: "text"; text: string }
	| { type: "thinking"; text: string }
	| { type: "tool-call"; name: string; callId?: string; arguments: Record<string, unknown> }
	| { type: "tool-result"; name: string; callId?: string; output: string; isError: boolean }
	| { type: "image"; mediaType: string }
	| { type: "json"; text: string };

export interface EntryView {
	id: number;
	kind: string;
	role: string;
	label: string;
	text: string;
	blocks: EntryBlock[];
	usage?: EntryUsage;
}

export function inboxRow(delivery: any): {
	threadId: string;
	messageId: string;
	messageUrl?: string;
	threadUrl?: string;
	subject: string;
	sender: string;
	at: number;
	read: boolean;
	unreadCount: number;
};
export interface PersonRef {
	url: string;
	kind: string;
}
export function inboxThreadRow(thread: any): {
	threadId: string;
	threadUrl?: string;
	subject: string;
	participants: PersonRef[];
	messageId?: string;
	messageUrl?: string;
	sender: PersonRef;
	snippet: string;
	at: number;
	unreadCount: number;
	archived: boolean;
};
export const PALETTE: Record<"blue" | "orange" | "purple" | "green" | "red" | "yellow" | "black", string>;
export const SESSION_COLORS: string[];
export function participantColor(participant: string | { url?: string; kind?: string }): string;
export function refLabel(url: string): string;
export function shortTime(at: number, now?: number, locale?: string): string;
export function threadRow(thread: any): {
	id: string;
	url: string;
	subject: string;
	snippet?: string;
	at: number;
	unreadCount: number;
	archived: boolean;
};
export function messageView(message: any): {
	id: string;
	url?: string;
	threadId?: string;
	threadUrl?: string;
	sender: string;
	senderKind: string;
	at: number;
	body: string;
	revised: boolean;
	redacted: boolean;
};
export function entryView(entry: any): EntryView;
export function commitView(commit: any): { hash: string; short: string; author: string; at: string; message: string };
export function memoryHitView(hit: any): { path: string; text: string };
export function scheduleWhen(schedule: { cron?: string | null; at?: number | null }): string;
export function scheduleBody(
	form: { kind?: string; when?: string; text?: string; to?: string },
	editing?: { kind?: string; payload?: Record<string, unknown> },
): { kind: string; payload: Record<string, unknown>; cron?: string; at?: string };
