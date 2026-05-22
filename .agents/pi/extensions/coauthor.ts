import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

const GIT_COAUTHOR_SHIM = String.raw`
git() {
	case "\${PI_DISABLE_COAUTHOR:-}:$1" in
		1:*)
			command git "$@"
			return $?
			;;
		*:commit|*:c|*:ci|*:cm)
			email=$(command git config user.email 2>/dev/null || true)
			case "$email" in
				*@*)
					pi_email="\${email%@*}+pi@\${email#*@}"
					command git "$@" --trailer "Co-authored-by: Josh's Pi Agent <$pi_email>"
					return $?
					;;
			esac
			;;
	esac
	command git "$@"
}
`;

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", (event) => {
		if (!isToolCallEventType("bash", event)) return undefined;
		if (event.input.command.includes("PI_DISABLE_COAUTHOR")) return undefined;

		event.input.command = `${GIT_COAUTHOR_SHIM}\n${event.input.command}`;
		return undefined;
	});
}
