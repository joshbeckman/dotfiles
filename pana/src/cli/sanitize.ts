// Untrusted text becomes terminal output — a message body, a thread subject, a schedule label —
// and a terminal acts on some of the bytes in it. ESC starts a sequence: OSC 52 writes the
// clipboard, OSC 0/2 retitles the window, OSC 8 makes ordinary text a link elsewhere. The C1
// range holds one-byte forms of those introducers, and CR or BS overwrite what was already
// printed.
//
// So the CLI sanitises every string it writes for a person, in one place. What is left prints
// literally: an OSC 52 message shows its `]52;c;...` payload as text, with no introducer to act
// on. Tab and newline survive, because rendered output is text and both are formatting, not
// control.
//
// JSON output keeps the exact string a machine asked for; there the encoder escapes the C0 range
// and `renderJson` escapes the C1 range, so no value leaves as a byte a terminal obeys.

/** C0 controls except tab (0x09) and newline (0x0a), DEL (0x7f), and the whole C1 range (0x80-0x9f). */
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/** Strip the controls a terminal obeys, leaving newlines and tabs. */
export function sanitizeTerminalText(text: string): string {
	return text.replace(CONTROL_CHARACTERS, "");
}

/** Escape the C1 range in an encoded JSON document, which `JSON.stringify` passes through raw. */
export function escapeJsonControls(document: string): string {
	return document.replace(/[\u007f-\u009f]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
