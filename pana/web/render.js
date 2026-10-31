// Rendering one message body (WEB-04, WEB-05): Markdown through the bundled marked and
// DOMPurify from agent-mail-web, `pana://` links rewritten to app routes, authenticated file
// bytes turned into blob URLs, and Mermaid diagrams rendered on demand.
//
// The functions take their inputs instead of reading globals, so tests can drive them with
// whichever renderer bundle is loaded.

import { appHref, panaLinkSegments } from "./links.js";

// DOMPurify strips an unknown scheme from href/src unless it is listed. Pana links are ours,
// and they are rewritten to app routes before the HTML reaches the DOM.
const ALLOWED_URI = /^(?:(?:https?|mailto|pana):|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i;

/** FIL-07: the widest copy an inline image asks for, so a photo does not arrive at full size. */
export const INLINE_WIDTH = 1024;

export function markdownToHtml(text, { marked, DOMPurify }) {
	const source = String(text ?? "");
	if (!marked || !DOMPurify) return escapeHtml(source);
	const html = marked.parse(source, { gfm: true, breaks: false });
	return DOMPurify.sanitize(html, { USE_PROFILES: { html: true, svg: true }, ALLOWED_URI_REGEXP: ALLOWED_URI });
}

export function escapeHtml(value) {
	return String(value).replace(
		/[&<>"']/g,
		(character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character],
	);
}

/**
 * Rewrite `pana://` anchors and images after sanitizing. File URLs are marked with
 * `data-file-path`; the caller fetches them with the bearer token, because an image tag cannot
 * send an Authorization header.
 */
export function rewriteLinks(root, domain) {
	for (const anchor of root.querySelectorAll("a[href]")) {
		const href = anchor.getAttribute("href") ?? "";
		const mapped = appHref(href, domain);
		if (!mapped) {
			anchor.removeAttribute("href");
			continue;
		}
		if (mapped.startsWith("/files/")) {
			anchor.setAttribute("data-file-path", mapped);
			anchor.setAttribute("href", "#");
			continue;
		}
		anchor.setAttribute("href", mapped);
		if (/^(https?:|mailto:)/i.test(mapped)) {
			anchor.setAttribute("target", "_blank");
			anchor.setAttribute("rel", "noopener noreferrer");
		}
	}
	for (const image of root.querySelectorAll("img[src]")) {
		const src = image.getAttribute("src") ?? "";
		const mapped = appHref(src, domain);
		if (!mapped) {
			image.removeAttribute("src");
			continue;
		}
		// The link keeps the original bytes; the picture gets a copy bounded by INLINE_WIDTH.
		if (mapped.startsWith("/files/")) {
			// Nothing can resolve a `pana://` image, so the source waits for the bytes the
			// authenticated route delivers instead of failing once per picture first.
			image.removeAttribute("src");
			image.setAttribute("data-file-path", `${mapped}?w=${INLINE_WIDTH}`);
		} else image.setAttribute("src", mapped);
	}
	return root;
}

/**
 * Turn `pana://` URLs written as plain text into links to their views (REF-08). Markdown only
 * makes an anchor when the author wrote link syntax, and a message body often just mentions a
 * session URL. Text inside an existing anchor is left alone.
 */
export function linkifyTextNodes(root, domain) {
	const walker = root.ownerDocument.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
	const nodes = [];
	while (walker.nextNode()) nodes.push(walker.currentNode);
	for (const node of nodes) {
		if (node.parentElement?.closest("a")) continue;
		const segments = panaLinkSegments(node.nodeValue ?? "", domain);
		if (!segments.some((segment) => segment.href)) continue;
		const fragment = root.ownerDocument.createDocumentFragment();
		for (const segment of segments) {
			if (!segment.href) {
				fragment.append(root.ownerDocument.createTextNode(segment.text));
				continue;
			}
			const anchor = root.ownerDocument.createElement("a");
			anchor.textContent = segment.text;
			if (segment.href.startsWith("/files/")) {
				anchor.dataset.filePath = segment.href;
				anchor.setAttribute("href", "#");
			} else {
				anchor.setAttribute("href", segment.href);
			}
			fragment.append(anchor);
		}
		node.replaceWith(fragment);
	}
	return root;
}

/** How many authenticated images the app fetches at a time, across every message on screen. */
export const FILE_CONCURRENCY = 6;

/** How far outside the viewport an image starts loading, so scrolling does not wait for bytes. */
export const FILE_MARGIN = "800px";

/**
 * FIL-07: one blob URL per file path, shared by every message that shows the file and kept for
 * the next render of the thread. A page of messages often repeats a picture, and reopening a
 * thread re-renders it; neither should fetch the same bytes again. The promise is cached, so two
 * messages asking at once make one request.
 */
function fileUrl(path, { cache, fetchFile }) {
	const known = cache.get(path);
	if (known) return known;
	const pending = fetchFile(path).then((blob) => {
		// A long session keeps a reference to every picture it showed; the cap bounds the map,
		// and the browser's own cache still has the bytes if an evicted one comes back.
		if (cache.size > 256) cache.delete(cache.keys().next().value);
		return URL.createObjectURL(blob);
	});
	cache.set(path, pending);
	// A failed fetch must not poison the path for the next render.
	pending.catch(() => cache.delete(path));
	return pending;
}

/**
 * The one line of authenticated file requests the app is running. Every message body shares it:
 * a page of thirty messages with two photos each is sixty images, and starting them all at once
 * on a phone just splits the same bandwidth sixty ways, so the picture the reader is looking at
 * arrives last. Visible images join the queue as they come into view, so they start first.
 */
const fileQueue = [];
let fileActive = 0;

function pumpFiles() {
	while (fileActive < FILE_CONCURRENCY && fileQueue.length > 0) {
		const load = fileQueue.shift();
		fileActive += 1;
		void load().finally(() => {
			fileActive -= 1;
			pumpFiles();
		});
	}
}

/**
 * Fetch each authenticated image and swap in a blob URL. Failures leave the alt text.
 *
 * Message bodies carry pictures inline, so a thread page can hold dozens of photos. Three things
 * keep that from stalling the thread: callers do not wait for bytes (the prose is already in
 * place), only images at or near the viewport are fetched (the rest load as the reader scrolls),
 * and the fetches that do run share one small queue instead of one request per image at once.
 */
export async function hydrateFiles(root, fetchFile, options = {}) {
	if (typeof fetchFile !== "function") return;
	const { cache = new Map(), margin = FILE_MARGIN } = options;
	for (const anchor of root.querySelectorAll("a[data-file-path]")) {
		const path = anchor.getAttribute("data-file-path");
		anchor.addEventListener("click", (event) => {
			event.preventDefault();
			fetchFile(path)
				.then((blob) => {
					const link = document.createElement("a");
					link.href = URL.createObjectURL(blob);
					link.download = anchor.textContent || "file";
					link.click();
					setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
				})
				.catch(() => {});
		});
	}
	const images = [...root.querySelectorAll("img[data-file-path]")].map((image) => ({
		image,
		path: image.getAttribute("data-file-path") ?? "",
	}));
	if (images.length === 0) return;

	const enqueue = ({ image, path }) => {
		fileQueue.push(async () => {
			try {
				// Decode off the main thread: a page of phone photos is a lot of pixels.
				image.decoding = "async";
				image.src = await fileUrl(path, { cache, fetchFile });
			} catch {
				image.replaceWith(document.createTextNode(`[Image unavailable: ${image.getAttribute("alt") ?? path}]`));
			}
		});
	};
	// An image out of view waits for the reader. Without an observer, everything loads at once.
	if (typeof IntersectionObserver !== "function") {
		for (const item of images) enqueue(item);
		pumpFiles();
		return;
	}
	const waiting = new Map(images.map((item) => [item.image, item]));
	const observer = new IntersectionObserver(
		(entries) => {
			let added = 0;
			for (const entry of entries) {
				if (!entry.isIntersecting) continue;
				observer.unobserve(entry.target);
				const item = waiting.get(entry.target);
				if (!item) continue;
				waiting.delete(entry.target);
				enqueue(item);
				added += 1;
			}
			if (added > 0) pumpFiles();
		},
		{ rootMargin: `${margin} 0px` },
	);
	for (const item of images) observer.observe(item.image);
}

/** Replace fenced mermaid blocks with rendered diagrams, loading the bundle only when needed. */
export async function renderDiagrams(root, { ensureMermaid, DOMPurify, idPrefix = "pana-diagram", dark = false }) {
	const blocks = [...root.querySelectorAll("pre > code.language-mermaid")];
	if (blocks.length === 0) return 0;
	let mermaid;
	try {
		mermaid = await ensureMermaid();
	} catch {
		for (const code of blocks) code.parentNode.insertAdjacentText("beforebegin", "Diagram renderer unavailable; source follows.");
		return 0;
	}
	mermaid.initialize({
		startOnLoad: false,
		securityLevel: "strict",
		theme: dark ? "dark" : "neutral",
		htmlLabels: false,
		flowchart: { htmlLabels: false },
		maxTextSize: 20000,
		suppressErrorRendering: true,
	});
	let rendered = 0;
	for (const [index, code] of blocks.entries()) {
		try {
			const { svg } = await mermaid.render(`${idPrefix}-${index}`, code.textContent ?? "");
			const container = document.createElement("div");
			container.className = "diagram";
			container.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
			code.parentNode.replaceWith(container);
			rendered++;
		} catch {
			code.parentNode.insertAdjacentText("beforebegin", "Diagram could not be rendered; source follows.");
		}
	}
	return rendered;
}

/**
 * Render one message body into `target` and prepare its links and images.
 *
 * The prose is in place when the returned promise settles: file bytes and diagrams follow on
 * their own, because a message can carry photos that are megabytes apiece and a page of
 * messages carries dozens. A caller that needs a picture waits for it in the DOM.
 */
export async function renderMessage(target, text, options) {
	target.innerHTML = markdownToHtml(text, options);
	// Keep wide tables locally scrollable without changing table semantics. Memory has its
	// own layout; only message/transcript prose opts into this treatment.
	if (target.classList.contains("prose")) {
		for (const table of target.querySelectorAll("table")) {
			const wrapper = target.ownerDocument.createElement("div");
			wrapper.className = "prose-table";
			wrapper.tabIndex = 0;
			wrapper.setAttribute("role", "region");
			wrapper.setAttribute("aria-label", "Scrollable table");
			table.replaceWith(wrapper);
			wrapper.append(table);
		}
	}
	rewriteLinks(target, options.domain);
	linkifyTextNodes(target, options.domain);
	void hydrateFiles(target, options.fetchFile, options).catch(() => {});
	void renderDiagrams(target, options).catch(() => {});
	return target;
}
