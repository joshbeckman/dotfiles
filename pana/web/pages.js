// List pages (SCALE-03). Every list route answers one page and a `nextCursor`; a list view
// shows a "Load more" button while there is one. These helpers keep the four list views the same.

export const PAGE_SIZE = 50;

/** `path` with the page size and, after the first page, the cursor. */
export function pagePath(path, cursor, limit = PAGE_SIZE) {
	const [base, search = ""] = path.split("?");
	const params = new URLSearchParams(search);
	params.set("limit", String(limit));
	if (cursor) params.set("cursor", cursor);
	else params.delete("cursor");
	return `${base}?${params}`;
}

/** The cursor for the next page, or undefined on the last page. */
export function nextCursor(body) {
	const cursor = body && typeof body === "object" ? body.nextCursor : undefined;
	return typeof cursor === "string" && cursor.length > 0 ? cursor : undefined;
}

/**
 * Replace the list's "Load more" button. With a cursor, the new button calls `load(cursor)`,
 * which appends the next page and calls this again.
 */
export function showMore(list, cursor, load) {
	list.querySelector(":scope > [data-more]")?.remove();
	if (!cursor) return;
	const button = list.ownerDocument.createElement("button");
	button.type = "button";
	button.className = "more";
	button.dataset.more = "";
	button.dataset.testid = "load-more";
	button.textContent = "Load more";
	button.addEventListener("click", () => {
		button.disabled = true;
		load(cursor);
	});
	list.append(button);
}
