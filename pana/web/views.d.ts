import type { ScheduleView } from "../src/schedules/store.ts";

// Types for the browser module `views.js`, which Node tests import directly.

export interface EntryUsage {
	input: number;
	output: number;
	costUsd: number;
}

export type EntryBlock =
	| { type: "text"; text: string; markdown?: true }
	| { type: "thinking"; text: string; markdown?: true }
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
/** UX-09: a session that is working in a thread. */
export interface WorkingSessionRef {
	sessionId: string;
	url: string;
	state: string;
}
export function isWorking(state: string): boolean;
export function workingOf(value: any): WorkingSessionRef[];
export function workingParticipants(thread: any): WorkingSessionRef[];
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
	working: WorkingSessionRef[];
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
	working: WorkingSessionRef[];
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
export function entryRaw(entry: any): string;
export function elapsedLabel(ms: number): string;
export function liveActivityLabel(live: { activity?: string; since?: number } | null | undefined, now: number): string;
export function commitView(commit: any): { hash: string; short: string; author: string; at: string; message: string };
export function memoryHitView(hit: any): { path: string; text: string };
export function memoryFileView(file: any): { path: string; content: string; commit: string };
export interface MemoryCommitFileView {
	path: string;
	status: string;
	additions: number;
	deletions: number;
	binary: boolean;
	patch: string;
	truncated: boolean;
}
export function memoryCommitFileView(file: any): MemoryCommitFileView;
export interface MemoryCommitDetailView {
	hash: string;
	short: string;
	author: string;
	at: unknown;
	subject: string;
	body: string;
	parents: string[];
	files: MemoryCommitFileView[];
	truncated: boolean;
}
export function memoryCommitView(commit: any): MemoryCommitDetailView;
export function scheduleWhen(schedule: { cron?: string | null; at?: number | null }): string;
export function scheduleBody(
	form: { subject?: string; kind?: string; when?: string; text?: string; to?: string },
	editing?: { subject?: string; kind?: string; payload?: Record<string, unknown> },
): { subject?: string | null; kind: string; payload: Record<string, unknown>; cron?: string; at?: string };

export function scheduleCheckView(
	schedule: Partial<Pick<ScheduleView, "check" | "checkCwd" | "stopAfterSuccess" | "lastCheck">>,
	formatTime?: (time: number) => string,
): { status: string; text: string } | null;
