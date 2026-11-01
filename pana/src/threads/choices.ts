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
// The browser parses the same syntax in `web/render.js`, the way `referenceFor` there matches
// `appendAttachmentMarkdown` here.

export const CHOICES_LANGUAGE = "choices";

/** How many options one message may offer. A menu longer than this is a worse question. */
export const MAX_CHOICES = 8;

/** How long one label or reply may be, which keeps a row of buttons on one line on a phone. */
export const MAX_CHOICE_LENGTH = 200;

/** The fence a message ends with, before the body is cleaned: ```choices … ```. */
const FENCE = new RegExp(`^\`\`\`${CHOICES_LANGUAGE}[ \\t]*\\n([\\s\\S]*?)^\`\`\`[ \\t]*$`, "gm");
/** One option line: a list marker and the text after it. */
const OPTION_LINE = /^[-*][ \t]+(.*)$/;

export interface Choice {
	/** What the button says. */
	label: string;
	/** What the click writes into the draft; the label itself when no `=>` was given. */
	reply: string;
}

/**
 * One option, as `LABEL` or `LABEL => REPLY`. The separator needs spaces on both sides so an
 * arrow inside a label (`->`, `=>` in code) does not split it.
 */
export function parseChoice(line: string): Choice | undefined {
	const trimmed = line.trim();
	const text = OPTION_LINE.exec(trimmed)?.[1] ?? trimmed;
	const at = text.indexOf(" => ");
	const label = (at === -1 ? text : text.slice(0, at)).trim();
	if (!label) return undefined;
	const reply = at === -1 ? label : text.slice(at + 4).trim() || label;
	return { label, reply };
}

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
	for (const choice of choices) {
		const option = parseChoice(choice);
		if (!option) return "every --choice needs a label";
		if (option.label.length > MAX_CHOICE_LENGTH || option.reply.length > MAX_CHOICE_LENGTH) {
			return `--choice labels and replies must be ${MAX_CHOICE_LENGTH} characters or fewer`;
		}
		if (option.reply.includes("\n")) return "--choice must fit on one line";
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
		const labels = String(inner)
			.split("\n")
			.map((line) => parseChoice(line)?.label)
			.filter((label): label is string => Boolean(label));
		return labels.length > 0 ? labels.join(" / ") : fence;
	});
}
