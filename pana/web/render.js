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
		if (mapped.startsWith("/files/")) image.setAttribute("data-file-path", mapped);
		else image.setAttribute("src", mapped);
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

/** Fetch each authenticated image and swap in a blob URL. Failures leave the alt text. */
export async function hydrateFiles(root, fetchFile) {
	if (typeof fetchFile !== "function") return;
	for (const image of root.querySelectorAll("img[data-file-path]")) {
		const path = image.getAttribute("data-file-path");
		try {
			const blob = await fetchFile(path);
			image.src = URL.createObjectURL(blob);
		} catch {
			image.replaceWith(document.createTextNode(`[Image unavailable: ${image.getAttribute("alt") ?? path}]`));
		}
	}
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

/** Render one message body into `target` and prepare its links and images. */
export async function renderMessage(target, text, options) {
	target.innerHTML = markdownToHtml(text, options);
	rewriteLinks(target, options.domain);
	linkifyTextNodes(target, options.domain);
	await hydrateFiles(target, options.fetchFile);
	await renderDiagrams(target, options);
	return target;
}
