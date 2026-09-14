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
import { vim, Vim, getCM } from "@replit/codemirror-vim";

const preference = (key) => {
  try {
    return localStorage.getItem("agent-mail." + key) || "";
  } catch {
    return "";
  }
};
const store = (key, value) => localStorage.setItem("agent-mail." + key, value);
const word = /[\p{L}\p{N}_@+.\-]+/u;

export function parseVimrc(source) {
  if (source.length > 65536)
    throw new Error("Mappings must be at most 64 KiB.");
  let leader = "\\";
  const mappings = [],
    ignored = [],
    aliases = new Map();
  for (const [index, raw] of source.split(/\r?\n/).entries()) {
    const line = raw.trim().replace(/^:/, "");
    if (!line || line.startsWith('"')) continue;
    const setting = /^let\s+mapleader\s*=\s*(["'])(.*?)\1$/.exec(line);
    if (setting) {
      leader = setting[2].replace(/\\(<[^>]+>)/g, "$1").replace(/\\\\/g, "\\");
      if (!leader) leader = "\\";
      if (leader === " ") leader = "<Space>";
      continue;
    }
    const command = /^(map|noremap|[nivo](?:map|noremap))\s+(.+)$/.exec(line);
    if (!command) {
      ignored.push(index + 1);
      continue;
    }
    const parts = command[2].replace(
      /^(?:(?:<silent>|<nowait>|<buffer>)\s+)*/i,
      "",
    );
    if (/^<(expr|script|unique)>/i.test(parts)) {
      ignored.push(index + 1);
      continue;
    }
    const binding = /^(\S+)\s+(.+)$/.exec(parts);
    if (!binding)
      throw new Error(
        `Line ${index + 1}: a mapping needs a key and an action.`,
      );
    if (binding[1].startsWith(":") && binding[1].length > 1)
      throw new Error(
        `Line ${index + 1}: Ex command aliases are not supported.`,
      );
    const context = {
      n: "normal",
      i: "insert",
      v: "visual",
      o: "operatorPending",
    };
    const mode = /^(map|noremap)$/.test(command[1])
      ? undefined
      : context[command[1][0]];
    let lhs = binding[1].replace(/<leader>/gi, leader);
    if (/^<leader>/i.test(binding[1]) && mode !== "insert") {
      // Vim's browser adapter prefers a complete builtin (e.g. Space) to a longer mapping.
      // A dedicated virtual prefix reserves the leader without removing builtin keymaps.
      const key = JSON.stringify([leader, mode]);
      if (!aliases.has(key))
        aliases.set(key, {
          lhs: leader,
          rhs:
            [...aliases.values()].find((alias) => alias.lhs === leader)?.rhs ||
            `<MailLeader${aliases.size}>`,
          mode,
          recursive: true,
        });
      lhs = binding[1]
        .replace(/^<leader>/i, aliases.get(key).rhs)
        .replace(/<leader>/gi, leader);
    }
    mappings.push({
      lhs,
      rhs: binding[2].replace(/<leader>/gi, leader),
      mode,
      recursive: !command[1].includes("noremap"),
    });
  }
  return { mappings, ignored, aliases: [...aliases.values()] };
}

export function create(parent, onChange, reportError) {
  const vimMode = new Compartment(),
    editable = new Compartment();
  let enabled = preference("vim") === "true",
    keywords = [],
    applied = [];
  const toggle = document.getElementById("vim-mode");
  const dialog = document.getElementById("vimrc-dialog");
  const input = document.getElementById("vimrc-input");
  const message = document.getElementById("vimrc-status");
  const applyMappings = (source) => {
    const parsed = parseVimrc(source);
    for (const mapping of applied) Vim.unmap(mapping.lhs, mapping.mode);
    applied = [...parsed.aliases, ...parsed.mappings];
    for (const mapping of applied)
      (mapping.recursive ? Vim.map : Vim.noremap)(
        mapping.lhs,
        mapping.rhs,
        mapping.mode,
      );
    return parsed;
  };
  input.value = preference("vimrc");
  try {
    applyMappings(input.value);
  } catch (error) {
    reportError(error);
  }
  toggle.checked = enabled;
  const state = (doc) =>
    EditorState.create({
      doc,
      extensions: [
        Prec.highest(
          EditorView.domEventHandlers({
            keydown(event, view) {
              if (event.isComposing) return false;
              // Reserve sending before either Vim or the default editor inserts a newline.
              if ((event.ctrlKey || event.metaKey) && event.key === "Enter")
                return true;
              const insert = !enabled || getCM(view)?.state.vim?.insertMode;
              if (!insert) return false;
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
        vimMode.of(enabled ? vim({ status: true }) : []),
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
              if (enabled && !getCM(editor)?.state.vim?.insertMode) return null;
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
          if (
            enabled &&
            completionStatus(update.state) &&
            !getCM(update.view)?.state.vim?.insertMode
          )
            // Mapped Escape changes Vim mode without passing through our keydown handler.
            queueMicrotask(() => {
              if (!getCM(update.view)?.state.vim?.insertMode)
                closeCompletion(update.view);
            });
        }),
      ],
    });
  const editor = new EditorView({ state: state(""), parent });
  toggle.addEventListener("change", () => {
    enabled = toggle.checked;
    editor.dispatch({
      effects: vimMode.reconfigure(enabled ? vim({ status: true }) : []),
    });
    try {
      store("vim", String(enabled));
    } catch {
      reportError("Vim mode changed, but the preference could not be saved.");
    }
    editor.focus();
  });
  document.getElementById("vimrc-button").onclick = () => {
    message.textContent = "";
    dialog.showModal();
    input.focus();
  };
  document.getElementById("vimrc-apply").onclick = () => {
    try {
      const parsed = applyMappings(input.value);
      message.textContent =
        `${parsed.mappings.length} mappings applied` +
        (parsed.ignored.length
          ? `; unsupported lines ignored: ${parsed.ignored.join(", ")}`
          : ".");
      store("vimrc", input.value);
    } catch (error) {
      message.textContent = error.message;
    }
  };
  dialog.addEventListener("close", () => editor.focus());
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
