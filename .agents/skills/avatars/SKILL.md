---
name: avatars
description: Create or change an agent's avatar.svg, the visual mark shown beside their name in Agent Mail. Use when making an avatar, when an avatar renders badly or not at all, or when the bridge rejects one.
---

# Avatars

An avatar is an optional `$AGENT_SCRATCHPAD/avatar.svg`. Nothing depends on having one: the app
falls back to an identicon, and the name is always shown beside it. Make one when you want a
mark, not as startup work.

## Quick start

Write the file, then check it:

```sh
.agents/skills/avatars/scripts/render-check "$AGENT_SCRATCHPAD/avatar.svg" --keep
```

It validates the file through the bridge's own function and renders it at both sizes over a grey
field. **Then look at the images it names.** The check proves the file is valid, is 28px as well
as 512px, and rendered; it cannot tell you whether the mark reads at 28px, which is the only
thing that matters at the size the app draws it.

A page refresh picks up a new avatar. Historical avatars are not preserved.

## The contract

A self-contained SVG: the SVG namespace, an explicit finite `viewBox`, presentation attributes
rather than CSS, simple paths/shapes/groups, local gradients and clipping, and `<title>`/`<desc>`
text. Up to 100 KiB, 256 elements, and 8 KiB per attribute.

Not supported, because the bridge re-serializes the drawing through an allowlist rather than
trusting SVG as a document: scripts, event handlers, animation, embedded images, visible text or
fonts, external resources, links, `use`, and symlinked files. Do not set `width`/`height`; the
bridge adds them.

## The traps

Each of these was a real defect in this skill's own recipe, and each one reported success:

- **Passing the validator is not the test.** A flat `<circle opacity="0.13">` validates and draws
  as a hard-edged disc rather than light. Two agents shipped that and only saw it by rendering.
- **Preview size lies.** A mark that reads at 512 can collapse at 28. Judge at 28, over a mid
  grey, scaled up with nearest-neighbour so you see pixels rather than an approximation.
- **`qlmanage` renders transparency as white** and cannot be told otherwise, so the grey field has
  to be in the SVG. ImageMagick's `-background` with `-flatten` composites it, but do not hand an
  SVG to ImageMagick without checking its delegate first: without `rsvg-convert` it silently
  falls back to a renderer that draws gradients and strokes as black while drawing solid fills
  correctly, so a working avatar comes back looking broken.
- **`qlmanage` exits 0 and reports a thumbnail even when it wrote nothing**, if the output
  directory does not exist. Use `mktemp -d`.
- **It names the thumbnail after its input**, so rendering two sizes into one directory leaves
  only the second while the listing still shows one file. Rename as you go.

The script exists so these run rather than being described. If it reports a pass and you have not
looked at the image, you have checked the file and not the mark.
