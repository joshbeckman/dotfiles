// The fence, CLI convenience flags, previews and browser share one choice grammar.
const OPTION_LINE = /^[-*][ \t]+(.*)$/;

/** LABEL, LABEL => REPLY, or QUESTION => LABEL => REPLY. */
export function parseChoice(line, previousQuestion) {
	let text = String(line).trim().replace(OPTION_LINE, "$1");
	if (text.endsWith(" =>")) text += " ";
	if (/^=>(?: |$)/.test(text)) return undefined;
	const first = text.indexOf(" => ");
	const second = first < 0 ? -1 : text.indexOf(" => ", first + 4);
	if (second < 0) {
		const label = (first < 0 ? text : text.slice(0, first)).trim();
		return label ? { label, reply: first < 0 ? label : text.slice(first + 4).trim() || label } : undefined;
	}
	const rawQuestion = text.slice(0, first).trim();
	const question = rawQuestion === "^" ? previousQuestion : rawQuestion;
	const label = text.slice(first + 4, second).trim();
	if (!question || !label) return undefined;
	return { question, label, reply: text.slice(second + 4).trim() || label };
}

/** Invalid fences stay visible as code; shorthand never leaks across fences. */
export function parseChoices(text) {
	const options = [];
	let question;
	for (const raw of String(text ?? "").split("\n")) {
		const line = raw.trim();
		if (!line) continue;
		if (!OPTION_LINE.test(line)) return null;
		const option = parseChoice(line, question);
		if (!option) return null;
		if (option.question) question = option.question;
		options.push(option);
	}
	return options.length ? options : null;
}

export function choiceText(option) {
	return option.question ? `> ${option.question}\n\n${option.reply}` : option.reply;
}

function inQuotedAnswer(lines, start) {
	let paragraph = start;
	while (paragraph > 0 && lines[paragraph - 1].trim()) paragraph -= 1;
	let before = paragraph - 1;
	while (before >= 0 && !lines[before].trim()) before -= 1;
	return before >= 0 && lines[before].trim().startsWith("> ");
}

function locate(draft, reply) {
	const lines = draft.split("\n");
	const block = reply.split("\n");
	const contextual = reply.startsWith("> ") && block.length > 1;
	const at = lines.findIndex((_, start) => {
		if (!block.every((line, offset) => lines[start + offset]?.trim() === line.trim())) return false;
		if (contextual) {
			// A soft line continuation is a hand-edited answer, not a known selection.
			const next = lines[start + block.length];
			return next === undefined || !next.trim();
		}
		// Legacy replies must not match lines inside a quoted question's answer paragraph.
		return !inQuotedAnswer(lines, start);
	});
	return { lines, block, at };
}

export function draftHasChoice(draft, reply) {
	return locate(draft, reply).at !== -1;
}

/** Only exact, known answers are replaced: hand-edited text remains the reader's. */
export function toggleChoice(draft, option, peers = []) {
	const text = choiceText(option);
	let found = locate(draft, text);
	if (found.at !== -1) {
		found.lines.splice(found.at, found.block.length);
		return found.lines.join("\n").replace(/^\s*\n+/, "").replace(/\s+$/, "");
	}
	if (option.question) {
		for (const peer of peers) {
			if (peer.question !== option.question) continue;
			found = locate(draft, choiceText(peer));
			if (found.at !== -1) {
				found.lines.splice(found.at, found.block.length, text);
				return found.lines.join("\n");
			}
		}
	}
	const head = draft.replace(/\s+$/, "");
	const lines = head.split("\n");
	const separator = option.question || inQuotedAnswer(lines, lines.length - 1) ? "\n\n" : "\n";
	return head ? `${head}${separator}${text}` : text;
}
