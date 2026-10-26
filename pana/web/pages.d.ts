// Types for the browser module `pages.js`, which Node tests import directly.

export const PAGE_SIZE: number;
export function pagePath(path: string, cursor: string | undefined, limit?: number): string;
export function nextCursor(body: unknown): string | undefined;
export function showMore(list: unknown, cursor: string | undefined, load: (cursor: string) => unknown): void;
