import { Compartment, EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap, drawSelection } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import {
  autocompletion,
  completionKeymap,
  startCompletion,
  closeCompletion,
  completionStatus,
  moveCompletionSelection,
  acceptCompletion,
} from "@codemirror/autocomplete";
import { markdown } from "@codemirror/lang-markdown";

const preference = (key) => {
  try {
    return localStorage.getItem("agent-mail." + key) || "";
  } catch {
    return "";
  }
};
const store = (key, value) => localStorage.setItem("agent-mail." + key, value);
const word = /[\p{L}\p{N}_@+.\-]+/u;

export function create(parent, onChange, reportError) {
  const editable = new Compartment();
  let keywords = [];
  const state = (doc) =>
    EditorState.create({
      doc,
      extensions: [
        Prec.highest(
          EditorView.domEventHandlers({
            keydown(event, view) {
              if (event.isComposing) return false;
              // Reserve sending before the default editor inserts a newline.
              if ((event.ctrlKey || event.metaKey) && event.key === "Enter")
                return true;
              if (
                event.ctrlKey &&
                !event.metaKey &&
                !event.altKey &&
                /^(n|p)$/.test(event.key)
              ) {
                return completionStatus(view.state) === "active"
                  ? moveCompletionSelection(event.key === "n")(view)
                  : startCompletion(view);
              }
              if (
                event.key === "Tab" &&
                completionStatus(view.state) === "active"
              )
                return acceptCompletion(view);
              if (event.key === "Escape" && completionStatus(view.state))
                return closeCompletion(view);
              return false;
            },
          }),
        ),
        editable.of([
          EditorState.readOnly.of(false),
          EditorView.editable.of(true),
        ]),
        history(),
        drawSelection(),
        markdown(),
        EditorView.lineWrapping,
        keymap.of([...completionKeymap, ...defaultKeymap, ...historyKeymap]),
        autocompletion({
          override: [
            (context) => {
              const match = context.matchBefore(word);
              if (!match || (!context.explicit && match.text.length < 2))
                return null;
              return {
                from: match.from,
                options: keywords.map((label) => ({ label, type: "text" })),
                validFor: /^[\p{L}\p{N}_@+.\-]*$/u,
              };
            },
          ],
        }),
        EditorView.contentAttributes.of({
          id: "body",
          role: "textbox",
          "aria-labelledby": "body-label",
          "aria-multiline": "true",
          spellcheck: "true",
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChange();
        }),
      ],
    });
  const editor = new EditorView({ state: state(""), parent });
  return {
    value: () => editor.state.doc.toString(),
    load: (value) => editor.setState(state(value)),
    focus: () => editor.focus(),
    keywords: (values) => {
      keywords = values;
    },
    readOnly: (value) =>
      editor.dispatch({
        effects: editable.reconfigure([
          EditorState.readOnly.of(value),
          EditorView.editable.of(!value),
        ]),
      }),
    insert: (text) => {
      editor.dispatch(editor.state.replaceSelection(text));
      editor.focus();
    },
  };
}
