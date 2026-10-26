// Types for the browser module `push.js`, which Node tests import directly.

export interface PushSubscriptionLike {
	endpoint: string;
	toJSON(): unknown;
}

export interface PushManagerLike {
	getSubscription(): Promise<PushSubscriptionLike | null>;
	subscribe(options: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }): Promise<PushSubscriptionLike>;
}

export interface RegistrationLike {
	pushManager?: PushManagerLike;
}

export interface SubscribeOptions {
	permission: string;
	requestPermission?: () => Promise<string>;
	register: () => Promise<RegistrationLike | undefined | null>;
	getKey: () => Promise<string>;
	post: (subscription: unknown) => Promise<void>;
}

export interface SubscribeResult {
	subscribed: boolean;
	reason?: string;
	endpoint?: string;
}

export function urlBase64ToUint8Array(base64: string): Uint8Array;
export function subscribeToPush(options: SubscribeOptions): Promise<SubscribeResult>;
