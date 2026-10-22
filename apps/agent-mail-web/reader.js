"use strict";
window.addEventListener("message", (event) => {
  if (
    event.source !== parent ||
    event.origin !== location.origin ||
    event.data?.type !== "render" ||
    typeof event.data.html !== "string"
  )
    return;
  document.documentElement.classList.toggle("dark", !!event.data.dark);
  document.body.innerHTML = event.data.html;
});
// scrollHeight can round down at fractional zoom, toggling scrollbars and reflowing text.
new ResizeObserver(() =>
  parent.postMessage(
    {
      type: "height",
      height: Math.ceil(document.body.getBoundingClientRect().height),
    },
    location.origin,
  ),
).observe(document.body);
document.addEventListener("keydown", (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing)
    return;
  if (
    ["j", "k", "o", "u", "e", "r", "a", "?", "/", "g", "i", "s", "d"].includes(
      event.key,
    )
  ) {
    event.preventDefault();
    parent.postMessage({ type: "key", key: event.key }, location.origin);
  }
});
// When the parent grows the frame, invalidate the whole document's paint once: Safari otherwise
// kept showing only the area that was visible before the resize, until something was clicked.
// An outline changes no layout, so this cannot feed back into the height reported above.
let repaintPending = false;
window.addEventListener("resize", () => {
  if (repaintPending) return;
  repaintPending = true;
  requestAnimationFrame(() => {
    document.documentElement.style.outline = "1px solid transparent";
    requestAnimationFrame(() => {
      document.documentElement.style.outline = "";
      repaintPending = false;
    });
  });
});
