// Tell the PWA and the user's devices about mail (PSH-03, INT-03, PSH-06..PSH-10).
//
// The store calls `announce` after its transaction commits, never inside it: a push is network
// I/O that must not hold the write queue, and a push that fails must not roll back the message.
// Push failures are reported and dropped; the message is already durable.
//
// The two halves of `announce` are gated differently on purpose:
//
// - The SSE publish to open windows is unconditional. It costs nothing, it is what the user sees
//   while working, and a message must always land in the inbox unread.
// - The push buzzes his phone, so it goes through the push gate: one `noul` question over the same
//   rendered delivery the wake gate reads, and silence below `PUSH_GATE_THRESHOLD`. A skipped push
//   is silence and nothing else. The inbox entry and its unread state are already committed.
//
// Never gated: a message from the user, an objective escalation (a domain delivery, the one notice
// that holds work until he answers), and a delivery that already has an answer recorded, so a
// retried delivery neither asks twice nor buzzes twice. Positional mail from the domain (scheduled
// wake and check notices) is gated: 104 of them arrived in the measured three weeks, none was read
// within the hour, and the question scores every one of them below the threshold
// (`docs/push-gate.md`).

import { planPushGate, type PushGatePlan } from "../decisions/push.ts";
import { logGateDecision } from "../decisions/log.ts";
import type { Runtime } from "../server/runtime.ts";
import { pushEvent, streamEvent, type WebEvent } from "../web/index.ts";
import { attachmentPaths, deliveryText } from "./render.ts";
import type { ThreadResult } from "./store.ts";

const PUSH_BODY_CHARS = 240;

function report(error: unknown): void {
	console.error("panad: push failed:", error instanceof Error ? error.message : error);
}

function excerpt(text: string | undefined): string | undefined {
	if (text === undefined) return undefined;
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > PUSH_BODY_CHARS ? `${flat.slice(0, PUSH_BODY_CHARS - 1)}…` : flat;
}

/** One delivery the caller just committed, and the recipient it belongs to. */
export interface AnnouncedDelivery {
	deliveryId: string;
	url: string;
}

/** A delivery whose push was already decided, reused instead of asking again (PSH-10). */
interface RecordedPush {
	probability: number;
	push: boolean;
}

/**
 * Publish one event per message. `streamEvent` sends it to open windows; the push that buzzes the
 * user's phone is decided by the push gate and sent from {@link pushFor}.
 */
export function announce(runtime: Runtime, kind: "delivery" | "notice", result: ThreadResult, deliveries: readonly AnnouncedDelivery[]): void {
	const toUser = deliveries.filter((delivery) => delivery.url === runtime.userUrl);
	if (toUser.length === 0) return;
	const { thread, message } = result;
	const event = streamEvent(runtime, {
		kind,
		to: runtime.userUrl,
		threadId: thread.id,
		messageId: message.id,
		senderUrl: message.sender.url,
		title: thread.subject ?? (kind === "notice" ? "pana notice" : `Message from ${message.sender.url}`),
		...(message.body === undefined ? {} : { body: excerpt(message.body) }),
	});
	void pushFor(runtime, kind, result, toUser, event).catch(report);
}

/**
 * The push half of `announce`: decide per delivery, record each answer against its delivery id,
 * log one line per decision, and push only the deliveries the gate keeps.
 *
 * A retried delivery reads its recorded answer (PSH-10) rather than asking the model again, so the
 * gate is never the reason a retry differs from the original.
 */
async function pushFor(
	runtime: Runtime,
	kind: "delivery" | "notice",
	result: ThreadResult,
	deliveries: readonly AnnouncedDelivery[],
	event: WebEvent,
): Promise<void> {
	const decisions = await decidePush(runtime, kind, result, deliveries);
	// A retried delivery reuses its answer without a second log line: the first one is the record.
	// A delivery with no decision at all (gate off, or the gate could not answer) pushes.
	if (!deliveries.some((delivery) => decisions.get(delivery.deliveryId)?.push !== false)) return;
	await pushEvent(runtime, event, report);
}

/**
 * The recorded and freshly asked answers for these deliveries, keyed by delivery id. A delivery
 * with no answer here pushes.
 *
 * Every failure in this path is reported and leaves the map incomplete rather than throwing: the
 * caller must not lose a push because a read, a write, or a render failed (PSH-09).
 */
async function decidePush(
	runtime: Runtime,
	kind: "delivery" | "notice",
	result: ThreadResult,
	deliveries: readonly AnnouncedDelivery[],
): Promise<Map<string, RecordedPush>> {
	const decisions = new Map<string, RecordedPush>();
	try {
		for (const [deliveryId, decided] of await recordedPushDecisions(runtime, deliveries.map((delivery) => delivery.deliveryId))) {
			decisions.set(deliveryId, decided);
		}
		const pending = deliveries.filter((delivery) => !decisions.has(delivery.deliveryId));
		if (pending.length === 0 || !gateable(runtime, kind, result)) return decisions;
		const plan: PushGatePlan | undefined = await planPushGate(
			runtime,
			await pushText(runtime, result),
			pending.map((delivery) => delivery.deliveryId),
			result.message.id,
		);
		for (const delivery of pending) {
			const decided = plan?.get(delivery.deliveryId);
			if (!decided) continue;
			decisions.set(delivery.deliveryId, decided);
			await recordPushDecision(runtime, delivery.deliveryId, decided);
			logGateDecision(runtime, {
				event: "push.gate",
				messageId: result.message.id,
				deliveryId: delivery.deliveryId,
				probability: decided.probability,
				decision: decided.push ? "push" : "skip",
			});
		}
	} catch (error) {
		// PSH-09: a broken gate pushes. The map may already hold answers; the rest push.
		report(error);
	}
	return decisions;
}

/**
 * Which kinds of mail the gate may skip. The user's own mail never reaches him as a delivery, and a
 * domain `delivery` is an objective escalation (OBJ-33), whose whole purpose is to reach him while
 * it holds the work. Everything else is ordinary mail.
 */
function gateable(runtime: Runtime, kind: "delivery" | "notice", result: ThreadResult): boolean {
	if (!runtime.config.decisionModel) return false;
	if (result.message.sender.kind === "user") return false;
	if (kind === "delivery" && result.message.sender.kind === "domain") return false;
	return true;
}

/** The rendered delivery the gate reads: the same frame and body a wake carries (DLV-02). */
async function pushText(runtime: Runtime, result: ThreadResult): Promise<string> {
	const { thread, message } = result;
	const body = message.body ?? "";
	return deliveryText({
		senderUrl: message.sender.url,
		threadUrl: runtime.url({ kind: "thread", id: thread.id }),
		messageUrl: runtime.url({ kind: "message", id: message.id, thread: thread.id }),
		subject: thread.subject,
		body,
		attachments: await attachmentPaths(runtime.db, runtime, body),
	});
}

async function recordedPushDecisions(runtime: Runtime, deliveryIds: readonly string[]): Promise<Map<string, RecordedPush>> {
	const found = new Map<string, RecordedPush>();
	if (deliveryIds.length === 0) return found;
	const rows = await runtime.db.all<{ delivery_id: string; probability: number; push: number }>(
		`SELECT delivery_id, probability, push FROM delivery_push_decisions
		  WHERE delivery_id IN (${deliveryIds.map(() => "?").join(",")})`,
		...deliveryIds,
	);
	for (const row of rows) found.set(row.delivery_id, { probability: row.probability, push: row.push !== 0 });
	return found;
}

/** Record one answer against its delivery id. A failed write is dropped, like the log line. */
async function recordPushDecision(runtime: Runtime, deliveryId: string, decided: RecordedPush): Promise<void> {
	try {
		await runtime.db.write((tx) =>
			tx.run(
				"INSERT OR IGNORE INTO delivery_push_decisions (delivery_id, probability, push, decided_at) VALUES (?, ?, ?, ?)",
				deliveryId,
				decided.probability,
				decided.push ? 1 : 0,
				runtime.clock.now(),
			),
		);
	} catch (error) {
		report(error);
	}
}
