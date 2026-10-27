import { EditorState } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { tags } from "@lezer/highlight";

// The site palette, in each scheme. CodeMirror's default highlight style is light-only, so
// pana defines its own from the same colors every other view uses.
const dark = matchMedia("(prefers-color-scheme: dark)").matches;
const light = [
  { tag: tags.heading, color: "#002FA7", fontWeight: "600" },
  { tag: tags.strong, color: "#0D0D0D", fontWeight: "700" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.link, color: "#002FA7", textDecoration: "underline" },
  { tag: tags.url, color: "#5C5C5C" },
  { tag: tags.monospace, fontFamily: "var(--font-mono)" },
  { tag: tags.quote, color: "#5C5C5C", fontStyle: "italic" },
  { tag: tags.list, color: "#903465" },
  { tag: [tags.keyword, tags.atom, tags.bool, tags.number], color: "#903465" },
  { tag: [tags.string, tags.special(tags.string)], color: "#237F52" },
  { tag: [tags.comment, tags.meta, tags.processingInstruction], color: "#5C5C5C" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: tags.invalid, color: "#BD2024" },
];
const night = [
  { tag: tags.heading, color: "#7FA4FF", fontWeight: "600" },
  { tag: tags.strong, color: "#FFFFFF", fontWeight: "700" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.link, color: "#7FA4FF", textDecoration: "underline" },
  { tag: tags.url, color: "#A3A3A3" },
  { tag: tags.monospace, fontFamily: "var(--font-mono)" },
  { tag: tags.quote, color: "#A3A3A3", fontStyle: "italic" },
  { tag: tags.list, color: "#D98AB3" },
  { tag: [tags.keyword, tags.atom, tags.bool, tags.number], color: "#FFB066" },
  { tag: [tags.string, tags.special(tags.string)], color: "#6FCF97" },
  { tag: [tags.comment, tags.meta, tags.processingInstruction], color: "#A3A3A3" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: tags.invalid, color: "#FF6B6B" },
];

export function create(parent, onChange) {
  const state = (doc) =>
    EditorState.create({
      doc,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        history(),
        drawSelection(),
        markdown(),
        syntaxHighlighting(HighlightStyle.define(dark ? night : light)),
        EditorView.lineWrapping,
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        EditorView.contentAttributes.of({
          "aria-label": "Memory file content",
          "aria-multiline": "true",
          spellcheck: "true",
          autocapitalize: "sentences",
          autocorrect: "on",
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
    destroy: () => editor.destroy(),
  };
}
