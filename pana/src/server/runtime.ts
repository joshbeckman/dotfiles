// The services a running panad hands to every handler and package.

import type { Harness, HarnessSettings, Registry } from "@earendil-works/pi-durable";
import type { Models } from "@earendil-works/pi-ai/models";
import type { SetTimer } from "@earendil-works/pi-durable";
import type { Config, StatePaths } from "../config/index.ts";
import type { PanaDatabase } from "../db/atomic.ts";
import type { WakeSubmitter } from "../db/outbox.ts";
import { formatUrl, monotonicUlidFactory, type Ref } from "../ids/index.ts";

/**
 * One clock for pi-durable and pana. Tests pass a fake one (test/harness/clock.ts). Pana's own
 * timers, such as schedules, use `setTimer` here so `clock.advance()` fires them too.
 */
export interface Clock {
	now(): number;
	setTimer: SetTimer;
}

export const systemClock: Clock = {
	now: () => Date.now(),
	setTimer: (callback, delayMs, options) => {
		const timer = setTimeout(callback, Math.max(0, delayMs));
		if (options.background) timer.unref();
		return () => clearTimeout(timer);
	},
};

export interface Runtime {
	config: Config;
	paths: StatePaths;
	db: PanaDatabase;
	harness: Harness;
	models: Models;
	registry: Registry;
	settings: HarnessSettings;
	clock: Clock;
	/** A new monotonic ULID on the runtime clock (ID-01). */
	newId(): string;
	/** A `pana://` URL on this domain. */
	url(ref: Ref): string;
	/** The domain URL, used as the sender of notices. */
	domainUrl: string;
	/** The configured user's URL. */
	userUrl: string;
	/** Submits a session wake for a delivery. WP3 owns the real one (src/sessions/wake.ts). */
	wake: WakeSubmitter;
}

export function createIdFactory(clock: Clock): () => string {
	return monotonicUlidFactory({ now: () => clock.now() });
}

export function urlHelpers(domain: string, user: string) {
	return {
		url: (ref: Ref) => formatUrl(ref, domain),
		domainUrl: formatUrl({ kind: "domain", id: domain }, domain),
		userUrl: formatUrl({ kind: "user", id: user }, domain),
	};
}
