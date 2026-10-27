// Types for the browser module `links.js`, which Node tests import directly.

export interface ThreadLike {
	id?: string;
	messages?: Array<{ id?: string }>;
}

export interface Route {
	section: string;
	id?: string;
	query: URLSearchParams;
}

export interface Draft {
	threadId?: string;
	after?: string;
	body: string;
}

export const SECTIONS: ReadonlyArray<{ id: string; title: string; route: string }>;
export const TOKEN_KEY: string;
export const CONFIRM_EDIT: string;
export const CONFIRM_REDACT: string;
export const CONFIRM_ARCHIVE_SESSION: string;

/** A segment of text: a plain run, or one link. */
export interface LinkSegment {
	text: string;
	href?: string;
}

/** The part of an uploaded file's view a Markdown reference needs (FIL-02, FIL-06). */
export interface Attachment {
	name: string;
	url: string;
	mediaType?: string | null;
}

export function isImageType(mediaType: unknown): boolean;
export function referenceFor(file: Partial<Attachment> | undefined): string;
export function appendReference(body: unknown, reference: string): string;
export function withReferences(body: unknown, files: ReadonlyArray<Partial<Attachment>> | undefined): string;

export function tokenFromInput(raw: unknown): string;
export function appHref(href: string | null | undefined, domain: string): string | undefined;
export function routeFromHash(hash: string): Route;
export function idHref(id: string | null | undefined, kind: string): string | undefined;
export function panaLinkSegments(text: unknown, domain: string): LinkSegment[];
export function newDraft(thread: ThreadLike | undefined): Draft;
export function notificationTarget(payload: { threadId?: string; url?: string } | undefined): string;
