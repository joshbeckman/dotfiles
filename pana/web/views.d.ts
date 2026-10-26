// Types for the browser module `views.js`, which Node tests import directly.

export function inboxRow(delivery: any): { threadId: string; messageId: string; subject: string; sender: string; at: number; read: boolean };
export function threadRow(thread: any): { id: string; url: string; subject: string; snippet?: string; at: number };
export function messageView(message: any): { id: string; sender: string; at: number; body: string; revised: boolean; redacted: boolean };
export function entryView(entry: any): { id: number; kind: string; role: string; text: string };
export function commitView(commit: any): { hash: string; short: string; author: string; at: string; message: string };
export function memoryHitView(hit: any): { path: string; text: string };
export function scheduleWhen(schedule: { cron?: string | null; at?: number | null }): string;
export function scheduleBody(
	form: { kind?: string; when?: string; text?: string; to?: string },
	editing?: { kind?: string; payload?: Record<string, unknown> },
): { kind: string; payload: Record<string, unknown>; cron?: string; at?: string };
