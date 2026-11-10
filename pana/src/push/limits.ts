// One process-wide limit, shared by all participants and runtimes. A timed-out transport holds
// its slot until it actually settles, even if an injected transport ignores cancellation.
export const PUSH_CONCURRENCY = 4;
export const PUSH_QUEUE_LIMIT = 128;

let running = 0;
interface Waiter {
	grant: () => void;
	cancel: () => void;
}
const queue: Waiter[] = [];

function release(): void {
	const next = queue.shift();
	if (next) next.grant();
	else running--;
}

/** Bound both running sends and waiters. A cancelled waiter never starts transport work. */
export async function withPushSlot<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
	if (signal.aborted) throw signal.reason;
	if (running < PUSH_CONCURRENCY) running++;
	else {
		if (queue.length >= PUSH_QUEUE_LIMIT) throw new Error("push send queue is full");
		await new Promise<void>((resolve, reject) => {
			const waiter: Waiter = {
				grant: () => { signal.removeEventListener("abort", waiter.cancel); resolve(); },
				cancel: () => {
					const index = queue.indexOf(waiter);
					if (index >= 0) queue.splice(index, 1);
					reject(signal.reason);
				},
			};
			queue.push(waiter);
			signal.addEventListener("abort", waiter.cancel, { once: true });
		});
	}
	try {
		if (signal.aborted) throw signal.reason;
		return await work();
	} finally {
		release();
	}
}
