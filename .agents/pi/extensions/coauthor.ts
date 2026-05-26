import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

const GIT_COAUTHOR_SHIM = [
	"git() {",
	'\tcase "${PI_DISABLE_COAUTHOR:-}:$1" in',
	"\t\t1:*)",
	'\t\t\tcommand git "$@"',
	"\t\t\treturn $?",
	"\t\t\t;;",
	"\t\t*:commit|*:c|*:ci|*:cm)",
	"\t\t\temail=$(command git config user.email 2>/dev/null || true)",
	'\t\t\tcase "$email" in',
	"\t\t\t\t*@*)",
	'\t\t\t\t\tpi_email="${email%@*}+pi@${email#*@}"',
	'\t\t\t\t\tcommand git "$@" --trailer "Co-authored-by: Josh\'s Pi Agent <$pi_email>"',
	"\t\t\t\t\treturn $?",
	"\t\t\t\t\t;;",
	"\t\t\tesac",
	"\t\t\t;;",
	"\tesac",
	'\tcommand git "$@"',
	"}",
].join("\n");

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", (event) => {
		if (!isToolCallEventType("bash", event)) return undefined;
		if (event.input.command.includes("PI_DISABLE_COAUTHOR")) return undefined;

		event.input.command = `${GIT_COAUTHOR_SHIM}\n${event.input.command}`;
		return undefined;
	});
}
