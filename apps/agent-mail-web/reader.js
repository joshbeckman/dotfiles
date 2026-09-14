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
new ResizeObserver(() =>
  parent.postMessage(
    { type: "height", height: document.body.scrollHeight },
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
