// The PWA and its live channel (WP8). The browser code lives in `pana/web/`; this package
// serves it, and `publish` is the entry point other packages use for SSE and Web Push.

export {
	isStaticAssetPath,
	launchUrl,
	loadAsset,
	loopbackOrigin,
	staticAsset,
	WEB_ROOT,
	type LoadedAsset,
	type StaticAsset,
} from "./static.ts";
export { publish, subscriberCount, subscribeEvents, type WebEvent } from "./events.ts";
export { handlers } from "./handlers.ts";
