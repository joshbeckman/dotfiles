// Types for the browser module `perf.js`, which Node tests import directly (OBS-03).

export const CLIENT_BATCH_MAX: number;
export const CLIENT_FLUSH_MS: number;

export type ClientKind = "api" | "view" | "longtask";

export interface ClientSample {
	kind: ClientKind;
	name: string;
	durationMs: number;
	status?: number;
}

export interface TelemetryPerformance {
	now(): number;
	getEntriesByType?(type: string): Array<{ domContentLoadedEventEnd: number }>;
}

export interface TelemetryDocument {
	visibilityState?: string;
	readyState?: string;
	addEventListener?(type: string, listener: () => void): void;
}

export interface TelemetryTarget {
	addEventListener?(type: string, listener: () => void): void;
	document?: TelemetryDocument;
	PerformanceObserver?: unknown;
}

export interface TelemetryOptions {
	post?: (samples: ClientSample[]) => unknown;
	target?: TelemetryTarget;
	performance?: TelemetryPerformance;
	flushMs?: number;
	maxSamples?: number;
}

export interface ClientTelemetry {
	now(): number;
	api(name: string, durationMs: number, status?: number): void;
	view(name: string, durationMs: number): void;
	longTask(durationMs: number): void;
	flush(): number;
	stop(): void;
	pending(): number;
	droppedSamples(): number;
}

export function apiName(method: string, path: string): string;
export function viewName(hash: string): string;
export function startClientTelemetry(options?: TelemetryOptions): ClientTelemetry | undefined;
export function clientBody(samples: unknown): { samples: unknown[] };
