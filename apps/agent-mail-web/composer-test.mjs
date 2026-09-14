import { test } from "node:test";
import assert from "node:assert/strict";
import { parseVimrc } from "./composer.js";

test("mapping modes and nonrecursive bindings", () => {
  const parsed = parseVimrc(
    "map Q gq\ninoremap <silent> <nowait> jk <Esc>\nvmap X x\nonoremap Y y",
  );
  assert.deepEqual(
    parsed.mappings.map((m) => [m.mode, m.recursive]),
    [
      [undefined, true],
      ["insert", false],
      ["visual", true],
      ["operatorPending", false],
    ],
  );
  assert.equal(parsed.mappings[1].lhs, "jk");
  assert.equal(parsed.mappings[1].rhs, "<Esc>");
});

test("leader reserves a virtual prefix instead of removing builtin keys", () => {
  for (const setting of ['let mapleader=" "', 'let mapleader="\\<Space>"']) {
    const { aliases, mappings } = parseVimrc(
      setting + "\nnnoremap <Leader>x dd",
    );
    assert.equal(aliases[0].lhs, "<Space>");
    assert.equal(aliases[0].recursive, true);
    assert.equal(mappings[0].lhs, aliases[0].rhs + "x");
    assert.equal(mappings[0].recursive, false);
  }
});

test("unsupported Vimscript is reported without executing it", () => {
  const parsed = parseVimrc(
    '" comment\nset number\nlua error("never execute")\ninoremap <expr> x dangerous()\ninoremap jk <Esc>',
  );
  assert.deepEqual(parsed.ignored, [2, 3, 4]);
  assert.equal(parsed.mappings.length, 1);
});

test("invalid configuration is rejected before applying any mappings", () => {
  assert.throws(() => parseVimrc("inoremap jk"), /needs a key and an action/);
  assert.throws(() => parseVimrc("nnoremap :foo :bar"), /Ex command aliases/);
  assert.throws(() => parseVimrc("x".repeat(65537)), /64 KiB/);
});
