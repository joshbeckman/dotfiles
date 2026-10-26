// Types for the browser module `push.js`, which Node tests import directly.

export interface PushSubscriptionLike {
	endpoint: string;
	options?: { applicationServerKey?: ArrayBuffer | Uint8Array | null };
	toJSON(): unknown;
	unsubscribe?(): Promise<boolean>;
}

export interface PushManagerLike {
	getSubscription(): Promise<PushSubscriptionLike | null>;
	subscribe(options: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }): Promise<PushSubscriptionLike>;
}

export interface RegistrationLike {
	pushManager?: PushManagerLike;
}

export interface BrowserEnv {
	secure: boolean;
	hasNotification: boolean;
	hasServiceWorker: boolean;
	hasPushManager: boolean;
	standalone: boolean;
	browser: "safari" | "chrome" | "edge" | "firefox" | "other";
	platform: "mac" | "ios" | "android" | "windows" | "linux" | "other";
	origin: string;
	host: string;
}

export type PushCause =
	| "insecure"
	| "unsupported"
	| "blocked"
	| "denied"
	| "dismissed"
	| "no-worker"
	| "no-key"
	| "subscribe-failed"
	| "server";

export interface SubscribeOptions {
	env?: BrowserEnv;
	permission: string;
	requestPermission?: () => Promise<string>;
	register: () => Promise<RegistrationLike | undefined | null>;
	getKey: () => Promise<string>;
	post: (subscription: unknown) => Promise<unknown>;
	now?: () => number;
}

export interface SubscribeResult {
	subscribed: boolean;
	cause?: PushCause;
	reason?: string;
	detail?: string;
	errorName?: string;
	elapsed?: number;
	endpoint?: string;
}

export const NO_PROMPT_MS: number;
export function urlBase64ToUint8Array(base64: string): Uint8Array;
export function browserEnv(input?: Partial<Omit<BrowserEnv, "browser" | "platform">> & { userAgent?: string }): BrowserEnv;
export function isIpHost(host: string): boolean;
export function pushSupport(env: BrowserEnv): SubscribeResult | null;
export function subscribeToPush(options: SubscribeOptions): Promise<SubscribeResult>;
export function explainPush(result: SubscribeResult, env?: BrowserEnv, options?: { localhostUrl?: string }): { text: string; link?: { href: string; label: string } };
