// Minimal types for the `web-push` package, which ships JavaScript without declarations.

declare module "web-push" {
	export interface PushSubscription {
		endpoint: string;
		keys: { p256dh: string; auth: string };
	}

	export interface VapidKeys {
		publicKey: string;
		privateKey: string;
	}

	export interface VapidDetails {
		subject: string;
		publicKey: string;
		privateKey: string;
	}

	export interface SendOptions {
		vapidDetails?: VapidDetails;
		TTL?: number;
		urgency?: "very-low" | "low" | "normal" | "high";
	}

	export interface SendResult {
		statusCode: number;
	}

	export function generateVAPIDKeys(): VapidKeys;
	export function generateRequestDetails(
		subscription: PushSubscription,
		payload?: string | Buffer,
		options?: SendOptions,
	): { method: string; headers: import("node:http").OutgoingHttpHeaders; body?: Buffer };
	export function sendNotification(
		subscription: PushSubscription,
		payload?: string | Buffer,
		options?: SendOptions,
	): Promise<SendResult>;

	const webpush: {
		generateVAPIDKeys: typeof generateVAPIDKeys;
		generateRequestDetails: typeof generateRequestDetails;
		sendNotification: typeof sendNotification;
	};
	export default webpush;
}
