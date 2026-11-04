// Reply options in a message body (WEB-10).
//
// A session that asks a closed question can end its message with a fenced `choices` block.
// The PWA renders it as buttons, and a click writes the option's reply into the draft below.
// Nothing is stored: the block is ordinary Markdown, so the CLI, search, edits, and history all
// see the same body, and the reply a user sends is plain prose that a session needs no parser
// for.
//
// ```choices
// - Ship it
// - Behind a flag => Ship behind PANA_CHOICES and tell me when it is fully on
// ```
//
// The CLI and browser share the grammar in `web/choices.js`.

export const CHOICES_LANGUAGE = "choices";

/** How many options one message may offer. A menu longer than this is a worse question. */
export const MAX_CHOICES = 8;

/** How long one label or reply may be, which keeps a row of buttons on one line on a phone. */
export const MAX_CHOICE_LENGTH = 200;

/** The fence a message ends with, before the body is cleaned: ```choices … ```. */
const FENCE = new RegExp(`^\`\`\`${CHOICES_LANGUAGE}[ \\t]*\\n([\\s\\S]*?)^\`\`\`[ \\t]*$`, "gm");
export { parseChoice, type Choice } from "../../web/choices.js";
import { parseChoice, parseChoices } from "../../web/choices.js";

/** The `choices` fence for a list of options, as the CLI appends it to a body. */
export function choicesMarkdown(choices: readonly string[]): string {
	const lines = choices.map((choice) => `- ${choice.trim()}`);
	return ["```" + CHOICES_LANGUAGE, ...lines, "```"].join("\n");
}

/** A body with the given options appended as one fence, or the body alone with no options. */
export function withChoices(body: string, choices: readonly string[]): string {
	if (choices.length === 0) return body;
	const fence = choicesMarkdown(choices);
	const head = body.replace(/\s+$/, "");
	return head ? `${head}\n\n${fence}` : fence;
}

/**
 * A usage problem with the options given to `--choice`, or undefined when they are usable. The
 * limits are advice to the writer, not a contract: the PWA renders a hand-written fence of any
 * length, because the body is the source of truth and a reader should see what was written.
 */
export function choiceProblem(choices: readonly string[]): string | undefined {
	if (choices.length > MAX_CHOICES) return `give at most ${MAX_CHOICES} --choice options`;
	let question: string | undefined;
	for (const choice of choices) {
		if (choice.includes("\n") || choice.includes("\r")) return "--choice must fit on one line";
		const option = parseChoice(choice, question);
		if (!option) return "every --choice needs a label and ^ needs a preceding question";
		if (option.question) question = option.question;
		if (
			(option.question?.length ?? 0) > MAX_CHOICE_LENGTH ||
			option.label.length > MAX_CHOICE_LENGTH ||
			option.reply.length > MAX_CHOICE_LENGTH
		) {
			return `--choice questions, labels and replies must be ${MAX_CHOICE_LENGTH} characters or fewer`;
		}
	}
	return undefined;
}

/**
 * The body with every choices fence replaced by its labels (`Yes / No, not yet`), so an inbox
 * row, a subject, or a push notification shows the options instead of the fence. A fence with no
 * options is left alone, the same way the renderer leaves one it cannot read.
 */
export function summarizeChoices(body: string): string {
	return String(body ?? "").replace(FENCE, (fence, inner: string) => {
		const options = parseChoices(inner);
		return options ? options.map((option) => option.label).join(" / ") : fence;
	});
}
