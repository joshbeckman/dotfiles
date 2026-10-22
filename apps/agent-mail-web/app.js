"use strict";
const $ = (id) => document.getElementById(id);
const { marked, DOMPurify } = MailRenderers;
const launchToken = location.hash.slice(1);
// localStorage, not sessionStorage: an installed app launches at "/" without
// the fragment, so the token must outlive the tab. The bridge keeps it stable.
if (launchToken) {
  localStorage.setItem("agent-mail-token", launchToken);
  history.replaceState(null, "", "/");
}
let token =
  localStorage.getItem("agent-mail-token") ||
  sessionStorage.getItem("agent-mail-token") ||
  "";
let folder = "inbox",
  view = "mail-list",
  items = [],
  selected = 0,
  current = null,
  draft = null;
let contacts = [],
  dirty = false,
  saving = Promise.resolve(),
  timer,
  listGeneration = 0,
  threadGeneration = 0;
let prefix = "",
  prefixAt = 0,
  busy = false,
  uploading = false,
  renderCounter = 0;
// A transient notice rather than a permanent bar: routine messages fade after a few seconds,
// errors stay until something replaces them. It keeps role=status, so it is still announced.
let statusTimer;
const status = (text, error = false) => {
  clearTimeout(statusTimer);
  $("status").textContent = text;
  $("status").classList.toggle("error", error);
  if (text && !error)
    statusTimer = setTimeout(() => {
      $("status").textContent = "";
    }, 5000);
};
const error = (e) => {
  status(e.message || String(e), true);
  // A 403 means this window holds no usable token, which is the normal state
  // for an installed app: Safari gives a Dock web app its own storage, so the
  // token a Safari tab stored never reaches it. Offer the paste instead of
  // leaving the server's instruction as a dead end.
  if (e.status === 403) showAuthorize();
};
// Accepts the whole launch URL or a bare token: people paste whichever they
// have to hand, and the fragment is the only part that is not guessable.
function tokenFromInput(raw) {
  const text = String(raw || "").trim();
  if (!text) return "";
  const hash = text.indexOf("#");
  if (hash >= 0) return text.slice(hash + 1).trim();
  return /^[A-Za-z0-9._~-]{20,}$/.test(text) ? text : "";
}
function showAuthorize() {
  $("authorize").hidden = false;
}
function hideAuthorize() {
  $("authorize").hidden = true;
}
async function authorize(raw) {
  const candidate = tokenFromInput(raw);
  if (!candidate) {
    $("authorize-status").textContent =
      "That does not look like a launch URL or token.";
    return;
  }
  const previous = token;
  token = candidate;
  try {
    // Prove it before keeping it, so a stale token does not silently replace a
    // working one and leave the window looking authorized but broken.
    await api("messages?folder=inbox&q=");
  } catch (e) {
    token = previous;
    $("authorize-status").textContent =
      e.status === 403
        ? "That token was rejected. Restart the bridge and use its new launch URL."
        : "Could not reach the bridge: " + (e.message || String(e));
    return;
  }
  localStorage.setItem("agent-mail-token", candidate);
  $("authorize-status").textContent = "Authorized.";
  hideAuthorize();
  await refresh().catch(error);
}
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
// Formatters are built once: toLocaleString with options builds a new one on every call, and
// the list formats each row's date two or three times.
const absoluteFormat = new Intl.DateTimeFormat([], {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
const fullFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "medium" });
const absoluteDate = (value) => {
  if (value == null || value === "") return "";
  const d = new Date(value);
  return Number.isNaN(+d) ? "" : absoluteFormat.format(d);
};
const relativeDate = new Intl.RelativeTimeFormat(undefined, {
  numeric: "always",
});
const date = (value) => {
  if (value == null || value === "") return "";
  const d = new Date(value);
  if (Number.isNaN(+d)) return "";
  const delta = +d - Date.now();
  const distance = Math.abs(delta);
  if (distance >= 3 * 24 * 60 * 60 * 1000) return absoluteDate(d);
  const [unit, size] =
    distance < 60 * 1000
      ? ["second", 1000]
      : distance < 60 * 60 * 1000
        ? ["minute", 60 * 1000]
        : distance < 24 * 60 * 60 * 1000
          ? ["hour", 60 * 60 * 1000]
          : ["day", 24 * 60 * 60 * 1000];
  const amount = Math.max(1, Math.round(distance / size));
  return relativeDate.format(delta < 0 ? -amount : amount, unit);
};
const describeTime = (element, value) => {
  if (value == null || value === "") return;
  const d = new Date(value);
  if (Number.isNaN(+d)) return;
  element.dateTime = d.toISOString();
  element.title = fullFormat.format(d);
};
// The editor and the diagram renderer are the two heaviest bundles in the app, and
// neither is needed to read mail. Each is fetched the first time it is used, so the
// first load carries the list and the reader rather than a code editor.
let composer = null;
let composerLoading = null;
function ensureComposer() {
  if (composer) return Promise.resolve(composer);
  if (!composerLoading) {
    composerLoading = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "/composer-vendor.js";
      script.onload = () => {
        if (!window.MailComposer) {
          reject(new Error("The editor bundle did not expose MailComposer."));
          return;
        }
        composer = MailComposer.create($("body-editor"), changed, error);
        resolve(composer);
      };
      script.onerror = () => reject(new Error("The editor bundle failed to load."));
      document.head.append(script);
    });
  }
  return composerLoading;
}
let mermaidLoading = null;
function ensureMermaid() {
  if (window.MailMermaid?.mermaid) return Promise.resolve(window.MailMermaid.mermaid);
  if (!mermaidLoading) {
    mermaidLoading = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "/mermaid-vendor.js";
      script.onload = () => {
        const lib = window.MailMermaid?.mermaid;
        if (!lib) {
          reject(new Error("The diagram bundle did not expose mermaid."));
          return;
        }
        resolve(lib);
      };
      script.onerror = () => reject(new Error("The diagram bundle failed to load."));
      document.head.append(script);
    });
  }
  return mermaidLoading;
}
let keywordGeneration = 0;
async function loadKeywords() {
  const generation = ++keywordGeneration;
  $("keyword-status").textContent = "Loading local keywords…";
  try {
    const result = await api("keywords");
    if (generation !== keywordGeneration) return;
    (await ensureComposer()).keywords(result.words);
    $("keyword-status").textContent = result.available
      ? `${result.words.length} local keyword${result.words.length === 1 ? "" : "s"} · Ctrl+n / Ctrl+p to complete, Tab to accept`
      : "No local keywords.txt found; editor remains available.";
  } catch (e) {
    if (generation !== keywordGeneration) return;
    composer?.keywords([]);
    $("keyword-status").textContent =
      "Keyword completion unavailable: " + e.message;
  }
}
async function api(path, data, extra = {}) {
  const response = await fetch("/api/" + path, {
    headers: {
      ...extra,
      "X-Agent-Mail-Token": token,
      ...(data ? { "Content-Type": "application/json" } : {}),
    },
    method: data ? "POST" : "GET",
    body: data ? JSON.stringify(data) : undefined,
  });
  const result = await response.json();
  if (!response.ok) {
    const failure = new Error(result.error || "Local bridge unavailable");
    failure.status = response.status;
    throw failure;
  }
  return result;
}
// Copying an id is how a message gets passed around. An agent reads one with
// `agent-mail read --id <id>`, and an id is what survives archiving while a key does not,
// so the id is the thing worth putting on the clipboard.
async function copyId(id) {
  if (!id) return;
  try {
    await navigator.clipboard.writeText(id);
  } catch {
    // navigator.clipboard wants a secure context, which loopback and the tailnet name both
    // are, but it can still be refused, so fall back to a hidden field rather than failing
    // silently.
    const field = document.createElement("textarea");
    field.value = id;
    field.setAttribute("readonly", "");
    field.style.position = "fixed";
    field.style.opacity = "0";
    document.body.append(field);
    field.select();
    try {
      document.execCommand("copy");
    } catch {
      /* the status line still shows the id, which is the other half of copying it */
    }
    field.remove();
  }
  status("Id copied: " + id);
}
// Opening a thread lands on the start of its newest message. The frames above it and the newest
// one size themselves after they draw, so the scroll repeats as each reports its height, until
// the reader scrolls on their own. Aligning the end instead left only the header of a long
// message in view once its frame grew.
let anchorLatest = false;
function scrollToLatestMessage() {
  if (!anchorLatest) return;
  const last = $("thread").lastElementChild;
  if (last) last.scrollIntoView({ block: "start" });
}
for (const type of ["wheel", "touchstart", "keydown", "pointerdown"])
  addEventListener(type, () => (anchorLatest = false), { passive: true, capture: true });
// A wide window shows the list beside the conversation, as a desktop mail client does. Below
// this the reader replaces the list: at 1,200px the list and a readable message do not both fit
// beside the rail and the folder sidebar.
const splitQuery = matchMedia("(min-width: 1360px)");
const isSplit = () => splitQuery.matches;
splitQuery.addEventListener("change", () => show(view));
function show(name) {
  view = name;
  const replying = name === "editor" && Boolean(draft?.parent);
  const split = isSplit() && (name === "mail-list" || name === "reader");
  document.querySelector("main").classList.toggle("replying", replying);
  document.body.classList.toggle("split", split);
  for (const id of ["mail-list", "reader", "editor", "contacts", "teams"])
    $(id).hidden =
      id !== name &&
      !(replying && id === "reader") &&
      !(split && id === "mail-list");
  $("reader-empty").hidden = !(split && name === "mail-list");
  // The phone reading view swaps the section rail for the message action bar, so the
  // layout needs to know the reader, not just the current view name.
  document.body.classList.toggle("reader-open", !$("reader").hidden);
  $("editor-title").textContent = draft?.parent ? "Reply" : "New message";
  setFolderButtons();
  setNavOpen(false);
  setMobileTitle();
  markSelected();
  syncHistory(name);
  if (name === "editor") renderRecipientCards();
}
// Back, whether the browser button or a phone's edge swipe, has to stay in the app. The app keeps
// one entry above its base and rewrites that entry's state rather than popping it: history.back()
// is asynchronous, and a traversal still pending when the next click or reload lands lands on
// top of it. The cost is at most one Back that does nothing after returning to the list in-app.
// Entries carry state only, never a URL, because the fragment is the launch token.
function syncHistory(name) {
  const state = history.state?.agentMail;
  if (name !== "mail-list") {
    if (state === "list") history.replaceState({ agentMail: "away" }, "");
    else if (state !== "away") history.pushState({ agentMail: "away" }, "");
  } else if (state === "away") history.replaceState({ agentMail: "list" }, "");
}
window.addEventListener("popstate", (event) => {
  if (event.state?.agentMail !== "away" && view !== "mail-list") navigate(folder, false).catch(error);
});
function setMobileTitle() {
  $("mobile-title").textContent =
    view === "contacts"
      ? "Contacts"
      : view === "teams"
        ? "Teams"
        : view === "editor"
          ? draft?.parent
            ? "Reply"
            : "New message"
          : folderTitle();
}
function markSelected() {
  const rows = $("rows").querySelectorAll(".row");
  rows.forEach((row, i) => row.classList.toggle("selected", i === selected));
  // In the split view the open conversation is the highlighted one, and it should stay on screen.
  if (isSplit() && view === "reader") rows[selected]?.scrollIntoView({ block: "nearest" });
}
function button(text, action) {
  const b = document.createElement("button");
  b.textContent = text;
  b.onclick = () => Promise.resolve().then(action).catch(error);
  return b;
}
function setFolderButtons() {
  const onMail = !["contacts", "teams"].includes(view);
  document
    .querySelectorAll("[data-folder]")
    .forEach((b) =>
      b.setAttribute(
        "aria-current",
        b.dataset.folder === folder && onMail ? "page" : "false",
      ),
    );
  for (const name of ["contacts", "teams"])
    $(name + "-button").setAttribute(
      "aria-current",
      view === name ? "page" : "false",
    );
  $("mail-button").setAttribute("aria-current", onMail ? "page" : "false");
}
function setNavOpen(open) {
  document.body.classList.toggle("nav-open", open);
  $("nav-toggle").setAttribute("aria-expanded", open ? "true" : "false");
}
// The last stamped list for each folder and search, so switching folders draws at once and the
// request only confirms it. The bridge answers an unchanged poll with the stamp alone.
const listCache = new Map();
const listCacheKey = () => folder + "\n" + $("search").value;
const FOLDER_NAMES = { inbox: "Inbox", archive: "Archive", sent: "Sent", drafts: "Drafts", all: "All mail" };
const folderTitle = () => ($("search").value ? "Search results" : FOLDER_NAMES[folder] || folder);
async function refresh(quiet = false) {
  const generation = ++listGeneration;
  const cacheKey = listCacheKey();
  const cached = listCache.get(cacheKey);
  const result = await api(
    "messages?group=1&folder=" +
      folder +
      "&q=" +
      encodeURIComponent($("search").value) +
      (cached ? "&version=" + cached.version : ""),
  );
  if (generation !== listGeneration) return;
  const fresh = result.unchanged && cached ? cached : result;
  listCache.set(cacheKey, fresh);
  applyList(fresh);
  if (fresh.warnings.length) status(fresh.warnings.join("; "), true);
  else if (!quiet && $("status").classList.contains("error")) status("");
}
function applyList(result) {
  const selectedKey = items[selected]?.key;
  const nextItems = result.messages;
  const listChanged = JSON.stringify(items) !== JSON.stringify(nextItems);
  items = nextItems;
  selected = Math.max(
    0,
    items.findIndex((m) => m.key === selectedKey),
  );
  for (const f of ["inbox", "archive", "sent", "drafts"])
    $("count-" + f).textContent = result.counts[f] || "";
  $("folder-title").textContent = folderTitle();
  $("list-count").textContent =
    items.length + (items.length === 1 ? " conversation" : " conversations");
  setMobileTitle();
  // The loading placeholder is not a list, so an empty folder still has to draw its message.
  if (listChanged || !$("rows").querySelector(".row, .rows-empty")) renderList();
}
function avatarKey(address) {
  const value = String(address || "unknown")
    .trim()
    .toLowerCase();
  if (value === "josh") return "human:josh";
  if (value.startsWith("humans/")) return "human:" + value.slice(7);
  if (value.startsWith("@") && !value.startsWith("@+"))
    return "human:" + value.slice(1);
  if (!value.startsWith("@+") && value.includes("@"))
    return "human:" + value.split("@")[0];
  return "agent:" + value.replace(/^@\+|^\+/, "").replace(/-[0-9a-f]{8}$/, "");
}
function hashOf(text) {
  let hash = 2166136261;
  for (const byte of new TextEncoder().encode(text))
    hash = Math.imul(hash ^ byte, 16777619) >>> 0;
  return hash;
}
// Active team memberships by avatar key, from the read-only team directory.
let teamsByMember = new Map();
function teamBadge(team) {
  const badge = document.createElement("span");
  badge.className = "team-badge";
  badge.style.background = `hsl(${(hashOf(team.handle) >>> 16) % 360} 60% 38%)`;
  badge.textContent = (team.handle.replace(/^@team\//, "")[0] || "?").toUpperCase();
  badge.setAttribute("aria-hidden", "true");
  return badge;
}
function decorateAvatar(wrap) {
  wrap.querySelectorAll(".team-badges").forEach((b) => b.remove());
  const teams = teamsByMember.get(wrap.dataset.key) || [];
  wrap.title = teams.length
    ? "Teams: " + teams.map((t) => `${t.name} (${t.handle})`).join(", ")
    : "";
  if (!teams.length) return;
  const badges = document.createElement("span");
  badges.className = "team-badges";
  badges.setAttribute("role", "img");
  badges.setAttribute("aria-label", wrap.title);
  badges.append(teamBadge(teams[0]));
  if (teams.length === 2) badges.append(teamBadge(teams[1]));
  if (teams.length > 2) {
    const more = document.createElement("span");
    more.className = "team-badge more";
    more.textContent = "+" + (teams.length - 1);
    more.setAttribute("aria-hidden", "true");
    badges.append(more);
  }
  wrap.append(badges);
}
async function loadTeamBadges() {
  const next = new Map();
  for (const team of await api("teams?q="))
    if (team.status === "active")
      for (const member of team.members)
        if (member.leftAt === null) {
          const key = avatarKey(member.handle);
          if (!next.has(key)) next.set(key, []);
          next.get(key).push(team);
        }
  teamsByMember = next;
  document.querySelectorAll(".avatar-wrap").forEach(decorateAvatar);
}
function avatar(address) {
  const wrap = document.createElement("span");
  wrap.className = "avatar-wrap";
  wrap.dataset.key = avatarKey(address);
  wrap.append(avatarImage(address));
  decorateAvatar(wrap);
  return wrap;
}
const avatarSources = new Map();
function scratchpadAvatar(handle) {
  handle = String(handle).trim().toLowerCase().replace(/^@\+|^\+/, "");
  if (!avatarSources.has(handle))
    avatarSources.set(handle, (async () => {
      try {
        const response = await fetch("/api/avatar?handle=" + encodeURIComponent("@+" + handle), {
          headers: { "X-Agent-Mail-Token": token },
        });
        if (!response.ok) {
          // Most agents have no avatar; release the 404 rather than leave its body pending.
          response.body?.cancel().catch(() => {});
          return "";
        }
        const blob = await response.blob();
        return await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
      } catch {
        return "";
      }
    })());
  return avatarSources.get(handle);
}
// Each sender's generated mark is built once; every list redraw asks for the same few again.
const identicons = new Map();
function identicon(key) {
  if (identicons.has(key)) return identicons.get(key);
  const hash = hashOf(key);
  const hue = (hash >>> 16) % 360;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="hsl(${hue} 30% 93%)"/>`;
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 5; x++) {
      if ((hash >>> (y * 3 + Math.min(x, 4 - x))) & 1 || (x === 2 && y === 2))
        svg += `<rect x="${6 + x * 4}" y="${6 + y * 4}" width="3.5" height="3.5" rx="0.5" fill="hsl(${hue} 65% 35%)"/>`;
    }
  }
  const url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg + "</svg>");
  identicons.set(key, url);
  return url;
}
function avatarImage(address) {
  const image = document.createElement("img");
  image.className = "avatar";
  image.alt = "";
  image.setAttribute("aria-hidden", "true");
  image.width = image.height = 28;
  const key = avatarKey(address);
  if (key === "human:josh") {
    image.src = "/josh-avatar.png";
    return image;
  }
  const fallback = identicon(key);
  image.src = fallback;
  if (key.startsWith("agent:"))
    scratchpadAvatar(address).then((src) => {
      if (!src) return;
      image.onerror = () => {
        image.onerror = null;
        image.src = fallback;
      };
      image.src = src;
    });
  return image;
}
const isJosh = (address) => avatarKey(address) === "human:josh";
const recipientsOf = (m) =>
  String(m.to || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
// Mail Josh wrote is listed by who it went to, as a Sent folder conventionally is; a row that
// says "josh" forty times tells him nothing.
function listName(m) {
  if (!isJosh(m.from)) return m.from || "Unknown sender";
  const to = recipientsOf(m);
  return to.length ? "To " + to.join(", ") : "No recipients yet";
}
let hoverTimer;
function renderList() {
  const rows = $("rows");
  rows.replaceChildren();
  if (!items.length) {
    const empty = document.createElement("p");
    empty.className = "rows-empty";
    empty.textContent = "No messages here.";
    rows.append(empty);
    return;
  }
  const showInbox = folder === "all" || Boolean($("search").value);
  items.forEach((m, i) => {
    const row = button("", () => openItem(i));
    row.className =
      "row" + (i === selected ? " selected" : "") + (m.folder === "drafts" ? " is-draft" : "");
    const subject = m.subject || "(no subject)";
    const chip =
      m.folder === "drafts"
        ? '<span class="chip chip-draft">Draft</span>'
        : showInbox && m.folder === "inbox"
          ? '<span class="chip chip-inbox">Inbox</span>'
          : "";
    row.innerHTML =
      '<span class="sender"><span class="sender-label"><span class="sender-name">' +
      escape(listName(m)) +
      "</span>" +
      (m.count > 1 ? '<span class="row-count">(' + m.count + ")</span>" : "") +
      "</span></span>" +
      chip +
      "<time>" +
      escape(date(m.date)) +
      '</time><span class="subject-line"><strong>' +
      escape(subject) +
      '</strong><span class="excerpt">' +
      escape(m.excerpt) +
      "</span></span>";
    const face = isJosh(m.from) ? recipientsOf(m)[0] || "josh" : m.from || "josh";
    row.querySelector(".sender").prepend(avatar(face));
    describeTime(row.querySelector("time"), m.date);
    // The visual order puts the date beside the sender; the spoken name keeps sender then
    // subject, which is also how the row is found by name.
    row.setAttribute(
      "aria-label",
      `${m.from || "Draft"} ${subject}. ${m.count > 1 ? m.count + " messages. " : ""}${date(m.date)}`,
    );
    row.addEventListener("pointerenter", () => {
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => prefetch(i), 80);
    });
    row.addEventListener("pointerleave", () => clearTimeout(hoverTimer));
    row.addEventListener("focus", () => prefetch(i));
    row.addEventListener("touchstart", () => prefetch(i), { passive: true });
    rows.append(row);
  });
}
// Conversations fetched ahead of the click: on hover, focus, touch, or a keyboard move. Opening one
// is then drawing rather than waiting, and the reader revalidates afterwards anyway.
const threadCache = new Map();
function fetchThread(key) {
  const entry = threadCache.get(key);
  if (entry && Date.now() - entry.at < 30000) return entry.promise;
  const promise = api("thread?key=" + encodeURIComponent(key));
  threadCache.set(key, { at: Date.now(), promise });
  promise.catch(() => threadCache.delete(key));
  return promise;
}
function prefetch(index) {
  const m = items[index];
  if (m && m.folder !== "drafts") fetchThread(m.key).catch(() => {});
}
async function navigate(target, clearSearch = true, query = "") {
  if (view === "editor") await saveDraft();
  ++threadGeneration;
  const changed = folder !== target || (clearSearch && $("search").value !== query);
  folder = target;
  if (clearSearch) $("search").value = query;
  document.body.classList.remove("search-open");
  setFolderButtons();
  if (changed) {
    selected = 0;
    const cached = listCache.get(listCacheKey());
    // Draw the folder from memory now; the request below only confirms or corrects it.
    if (cached) applyList(cached);
    else {
      items = [];
      $("folder-title").textContent = folderTitle();
      $("list-count").textContent = "";
      setMobileTitle();
      $("rows").replaceChildren(loadingRows());
    }
  }
  show("mail-list");
  await refresh();
}
function loadingRows() {
  const holder = document.createElement("div");
  holder.className = "rows-loading";
  holder.setAttribute("aria-hidden", "true");
  for (let i = 0; i < 6; i++) holder.append(document.createElement("span"));
  return holder;
}
async function openItem(index = selected) {
  if (!items[index]) return;
  selected = index;
  const m = items[index];
  if (m.folder === "drafts")
    return loadDraft(await api("draft?key=" + encodeURIComponent(m.key)));
  await openThread(m);
}
async function openThread(m) {
  const generation = ++threadGeneration;
  const entry = threadCache.get(m.key);
  // Anything fetched more than a moment ago is drawn now and checked again just after.
  const reused = Boolean(entry) && Date.now() - entry.at > 1500;
  const messages = await fetchThread(m.key);
  if (generation !== threadGeneration) return false;
  const key =
    m.folder === "drafts"
      ? messages.find((message) => message.id === m.parent)?.key ||
        messages.at(-1)?.key ||
        m.key
      : m.key;
  current = { key, messages };
  $("thread-title").textContent = m.subject || "(no subject)";
  // A thread's id is the id of its root message, which is the reference for the whole
  // conversation rather than for one message in it.
  $("thread-id").textContent = messages[0]?.thread || messages[0]?.id || "";
  threadSummary(messages);
  $("thread").replaceChildren();
  show("reader");
  $("thread-title").focus();
  for (const [i, message] of messages.entries())
    appendThreadMessage(
      message,
      message.key === key || i === messages.length - 1,
    );
  if (!messages.length)
    $("thread").textContent =
      "Earlier messages are not available for this draft.";
  anchorLatest = true;
  scrollToLatestMessage();
  offerThreadTranscript();
  if (reused) refreshThread().catch(() => {});
  return true;
}
function threadSummary(messages) {
  $("participants").textContent =
    "Participants: " +
    [
      ...new Set(
        messages
          .flatMap((v) => [v.from, ...v.to.split(",")])
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    ].join(", ");
  $("archive").disabled = !messages.some((v) => v.folder === "inbox");
  renderParticipantCards(messages);
}
// Appends replies that arrived while the thread is open. Existing messages
// stay in place, so open/closed state, scroll, selection, and an inline
// reply draft survive.
async function refreshThread() {
  const open = current;
  const generation = threadGeneration;
  const messages = await api("thread?key=" + encodeURIComponent(open.key));
  if (open !== current || generation !== threadGeneration) return;
  threadCache.set(open.key, { at: Date.now(), promise: Promise.resolve(messages) });
  // By id, not key: archiving moves a message to another folder and changes its key, and that
  // is the same message, not a new one to append.
  const known = new Set(open.messages.map((v) => v.id));
  const fresh = messages.filter((v) => !known.has(v.id));
  const keys = (list) => list.map((v) => v.key).join("\n");
  const moved = keys(open.messages) !== keys(messages.filter((v) => known.has(v.id)));
  if (!fresh.length && !moved) return;
  if (fresh.length && !open.messages.length) $("thread").replaceChildren();
  for (const message of fresh) appendThreadMessage(message, true);
  current = { ...open, messages };
  threadSummary(messages);
  if (!fresh.length) return;
  const senders = [...new Set(fresh.map((v) => v.from))].join(", ");
  status(`New ${fresh.length === 1 ? "message" : "messages"} from ${senders}.`);
}
// Attach before rendering: the sandboxed reader frame sizes itself once loaded.
// A thread can have a transcript of its own when an agent-run runtime owns it. The link is
// offered only after a probe says the transcript exists, so it never leads to a 404, and the
// probe is fire-and-forget so the reader is not held behind it.
async function offerThreadTranscript() {
  const id = $("thread-id").textContent;
  const link = $("thread-transcript");
  link.hidden = true;
  if (!id) return;
  try {
    const probe = await api(
      "transcript?thread=" + encodeURIComponent(id) + "&probe=1",
    );
    // A slower probe for a thread the reader has already left must not add its link here.
    if (probe.available && $("thread-id").textContent === id) {
      link.href = "/transcript.html?thread=" + encodeURIComponent(id);
      link.hidden = false;
    }
  } catch {
    // An unavailable probe is not something the reader needs to be told about.
  }
}
// The first words of a message for its collapsed header, with the Markdown punctuation that
// would read as noise there taken out.
function snippetOf(body) {
  return String(body || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_`~|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}
function appendThreadMessage(message, open) {
  const detail = document.createElement("details");
  detail.className = "message";
  detail.open = open;
  const summary = document.createElement("summary");
  const to = recipientsOf(message);
  summary.innerHTML =
    '<span class="msg-from">' +
    escape(message.from) +
    "</span>" +
    (message.folder !== "inbox"
      ? '<span class="chip">' + escape(FOLDER_NAMES[message.folder] || message.folder) + "</span>"
      : "") +
    '<span class="msg-to">to ' +
    escape(to.join(", ") || "nobody") +
    '</span><span class="msg-snippet">' +
    escape(snippetOf(message.body)) +
    "</span><time>" +
    escape(date(message.date)) +
    "</time>";
  describeTime(summary.querySelector("time"), message.date);
  summary.prepend(avatar(message.from));
  detail.append(summary);
  const metadata = document.createElement("p");
  metadata.className = "metadata";
  metadata.textContent =
    "To: " +
    message.to +
    (message.parent ? " · In reply to " + message.parent : "");
  // One line, with the whole of it on hover: the parent id is for passing around, not reading.
  metadata.title = metadata.textContent;
  detail.append(metadata);
  const content = document.createElement("div");
  detail.append(content);
  $("thread").append(detail);
  let rendered = false;
  const render = () => {
    if (!rendered && detail.open) {
      rendered = true;
      renderMarkdown(message.body, content)
        .then(() => {
          if (detail === $("thread").lastElementChild) scrollToLatestMessage();
        })
        .catch(error);
    }
  };
  detail.addEventListener("toggle", render);
  render();
  const actions = document.createElement("div");
  actions.className = "render-tools";
  actions.append(
    button("Reply to this message", () => newDraft("reply", message.key)),
    button("Reply all", () => newDraft("reply-all", message.key)),
    button("Copy id", () => copyId(message.id)),
  );
  const identifier = document.createElement("code");
  identifier.className = "permalink";
  identifier.textContent = message.id;
  actions.append(identifier);
  detail.append(actions);
}
async function archiveThread() {
  if (busy) return;
  busy = true;
  try {
    const fromReader = view === "reader" && Boolean(current);
    const messages = fromReader
      ? current.messages
      : items[selected]
        ? await fetchThread(items[selected].key)
        : [];
    const thread = messages[0]?.thread;
    const index = items.findIndex((m) => m.folder !== "drafts" && m.thread === thread);
    // The row goes before the bridge confirms, so the list answers the keypress at once. The
    // confirmation below waits for the files to move, and a failure redraws the real list.
    if (folder === "inbox" && index >= 0) {
      items.splice(index, 1);
      selected = Math.min(index, Math.max(0, items.length - 1));
      renderList();
    }
    // Beside the list, the next conversation takes the reading pane, as a mail client does.
    const next = isSplit() && fromReader && folder === "inbox" ? items[selected] : null;
    if (next && next.folder !== "drafts") openThread(next).catch(error);
    else show("mail-list");
    status("Archiving…");
    try {
      for (const m of messages.filter((m) => m.folder === "inbox"))
        await api("archive", { key: m.key });
    } finally {
      threadCache.clear();
      await refresh(true).catch(() => {});
    }
    status("Conversation archived.");
  } finally {
    busy = false;
  }
}
async function newDraft(mode = "compose", key = current?.key) {
  if (view === "editor") await saveDraft();
  return loadDraft(await api("draft", { mode, key }));
}
async function loadDraft(value) {
  draft = value;
  dirty = false;
  $("to").value = value.to;
  $("recipient-cards").replaceChildren();
  $("subject").value = value.subject;
  (await ensureComposer()).load(value.body);
  loadKeywords();
  $("preview").hidden = true;
  $("preview").replaceChildren();
  $("draft-status").textContent = "Saved on disk";
  if (value.parent && !(await openThread(value))) return;
  show("editor");
  // Position the section first, then focus without letting the focus scroll: on a phone the
  // focus scroll and the section scroll arrive as two jumps, which reads as flicker. The
  // action row is at the top of the section, so this is what keeps it on screen.
  $("editor").scrollIntoView({ block: "start" });
  if (value.to) $("body").focus({ preventScroll: true });
  else $("to").focus({ preventScroll: true });
}
function saveDraft() {
  clearTimeout(timer);
  saving = saving
    .catch(() => {})
    .then(async () => {
      while (draft && dirty) {
        const old = draft;
        const editor = await ensureComposer();
        const fields = {
          to: $("to").value,
          subject: $("subject").value,
          body: editor.value(),
        };
        const result = await api("save", {
          key: old.key,
          revision: old.revision,
          ...fields,
        });
        if (draft === old) {
          draft = result;
          dirty = Object.entries(fields).some(
            ([k, v]) => (k === "body" ? editor.value() : $(k).value) !== v,
          );
          $("draft-status").textContent =
            "Saved on disk · " + new Date().toLocaleTimeString();
        }
      }
    });
  return saving;
}
function changed() {
  dirty = true;
  $("draft-status").textContent = "Unsaved changes";
  clearTimeout(timer);
  timer = setTimeout(() => saveDraft().catch(error), 750);
}
async function sendDraft() {
  if (!draft || busy) return;
  if (uploading) throw new Error("Wait for the image upload before sending.");
  busy = true;
  const controls = [...document.querySelectorAll("button,input,textarea")].map(
    (el) => [el, el.disabled],
  );
  controls.forEach(([el]) => (el.disabled = true));
  const editor = await ensureComposer();
  editor.readOnly(true);
  try {
    await saveDraft();
    const sent = await api("send", {
      key: draft.key,
      revision: draft.revision,
    });
    threadCache.clear();
    const reply = Boolean(draft.parent);
    const message = { key: sent.key, subject: draft.subject };
    draft = null;
    dirty = false;
    if (reply) {
      await refresh(true);
      await openThread(message);
    } else {
      await navigate("sent");
    }
    status("Sent. A copy is retained in Sent.");
  } finally {
    busy = false;
    controls.forEach(([el, disabled]) => (el.disabled = disabled));
    editor.readOnly(false);
    if (view === "reader" && current)
      $("archive").disabled = !current.messages.some(
        (m) => m.folder === "inbox",
      );
  }
}
// Starting an agent is not sending. Nothing is delivered to a mailbox: the message
// becomes the first task a new session reads. The session names itself once it starts,
// so the only thing there is to report back is where it was started.
async function spawnAgent() {
  if (busy) return;
  const body = (await ensureComposer()).value().trim();
  if (!body) throw new Error("Write the task for the new agent first.");
  busy = true;
  const controls = [...document.querySelectorAll("button,input,textarea")].map(
    (el) => [el, el.disabled],
  );
  controls.forEach(([el]) => (el.disabled = true));
  try {
    const started = await api("spawn", { subject: $("subject").value, body });
    status(
      `Started an agent in ${started.session}:${started.window}. It names itself once it starts.`,
    );
  } finally {
    busy = false;
    controls.forEach(([el, disabled]) => (el.disabled = disabled));
  }
}
async function deleteDraft() {
  if (!draft || busy) return;
  if (uploading) throw new Error("Wait for the image upload before deleting.");
  if (
    !confirm(
      "Delete this draft and discard its unsaved changes? This cannot be undone.",
    )
  )
    return;
  busy = true;
  clearTimeout(timer);
  const controls = [...document.querySelectorAll("button,input,textarea")].map(
    (el) => [el, el.disabled],
  );
  controls.forEach(([el]) => (el.disabled = true));
  const editor = await ensureComposer();
  editor.readOnly(true);
  try {
    // A pending save may advance the revision; deletion still checks disk state if it failed.
    await saving.catch(() => {});
    await api("delete-draft", { key: draft.key, revision: draft.revision });
    draft = null;
    dirty = false;
    await navigate("drafts");
    status("Draft deleted.");
  } finally {
    busy = false;
    controls.forEach(([el, disabled]) => (el.disabled = disabled));
    editor.readOnly(false);
  }
}
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const UPLOADABLE_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
];
function base64Of(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
function loadImage(file) {
  // A data URL, not a blob URL: the app's CSP allows img-src 'self' data: and would
  // block blob:.
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () =>
        reject(new Error("Could not read that image; try a PNG or JPEG."));
      image.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
// The bridge accepts only PNG/JPEG/GIF/WebP and at most 5 MiB, and a phone photo can
// be a HEIC or larger than that. Re-encode only when the file would otherwise be
// rejected, so a small GIF keeps its animation and a normal screenshot uploads as-is.
async function uploadData(file) {
  if (file.size <= MAX_IMAGE_BYTES && UPLOADABLE_IMAGE_TYPES.includes(file.type))
    return base64Of(file);
  const image = await loadImage(file);
  const initial = Math.min(1, 2560 / Math.max(image.width, image.height));
  for (let factor = initial; factor > 0.1; factor *= 0.75) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * factor));
    canvas.height = Math.max(1, Math.round(image.height * factor));
    canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.85),
    );
    if (blob && blob.size <= MAX_IMAGE_BYTES) return base64Of(blob);
  }
  throw new Error("Could not shrink that image enough to send it.");
}
async function attach() {
  const file = $("image").files[0];
  if (!file || uploading) return;
  const key = draft?.key;
  uploading = true;
  try {
    const data = await uploadData(file);
    const result = await api("attachment", { data });
    if (draft?.key !== key || view !== "editor")
      throw new Error(
        "Draft changed during image upload. Attach it again to the intended message.",
      );
    (await ensureComposer()).insert(
      "\n![" +
        file.name.replace(/[\[\]<>\r\n]/g, "") +
        "](" +
        result.url +
        ")\n",
    );
    $("image").value = "";
  } finally {
    uploading = false;
  }
}
let contactGeneration = 0;
async function getContacts(query = "") {
  const generation = ++contactGeneration;
  $("contact-status").textContent = query
    ? "Searching session transcripts…"
    : "Loading contacts…";
  try {
    const results = await api("contacts?q=" + encodeURIComponent(query));
    if (generation !== contactGeneration) return;
    contacts = results;
    if (!query)
      $("contact-options").replaceChildren(
        ...contacts
          .filter((c) => c.addressable)
          .map((c) => {
            const option = document.createElement("option");
            option.value = c.handle;
            return option;
          }),
      );
    $("contact-status").textContent = query
      ? results.length +
        " matching sessions · up to 30 results ranked by matching transcript lines"
      : results.length + " contacts · expand a contact for agent-find details";
    renderContacts();
  } catch (e) {
    if (generation === contactGeneration)
      $("contact-status").textContent = e.message;
    throw e;
  }
}
function sessionDetails(session, compact = false) {
  const observedTime = (value) => date(value) || "Time not recorded";
  const section = document.createElement("div");
  const dl = document.createElement("dl");
  const extra = document.createElement("dl");
  dl.className = extra.className = "session-details";
  for (const [label, value] of [
    ["Title", session.title],
    ["Liveness", session.liveness],
    ["Harness", session.harness || "Unknown"],
    [
      "Latest recorded model",
      session.model ? `${session.provider}/${session.model}` : "Unknown",
    ],
    ["Model observed", observedTime(session.modelObservedAt)],
    [
      "Model evidence",
      session.modelSource === "model_change"
        ? "Recorded selection"
        : session.modelSource === "assistant"
          ? "Assistant message"
          : "No model metadata",
    ],
    ["Working directory", session.cwd],
    ["Session", session.sessionId],
    ["Started", session.started ? observedTime(session.started) : null],
    ["Matching lines", session.matches],
    ["Scratchpad", session.scratchpad || "No retained scratchpad"],
    ["Transcript", session.sessionFile],
  ]) {
    if (value == null) continue;
    const term = document.createElement("dt");
    term.textContent = label;
    const detail = document.createElement("dd");
    detail.textContent = value;
    const target =
      compact &&
      ![
        "Title",
        "Liveness",
        "Harness",
        "Latest recorded model",
        "Working directory",
      ].includes(label)
        ? extra
        : dl;
    target.append(term, detail);
  }
  const resume = document.createElement("pre");
  resume.className = "source";
  resume.textContent = session.resume;
  section.append(dl);
  const memberships = document.createElement("section");
  memberships.className = "team-memberships";
  memberships.setAttribute("aria-label", "Team memberships");
  const teamTitle = document.createElement("h4");
  teamTitle.textContent = "Teams";
  memberships.append(teamTitle);
  if (!Array.isArray(session.teams) || !session.teams.length) {
    const message = document.createElement("p");
    message.className = "metadata";
    message.textContent = Array.isArray(session.teams)
      ? "No active teams."
      : "Team membership unavailable.";
    memberships.append(message);
    if (session.teamsWarning) {
      const warning = document.createElement("p");
      warning.className = "hint";
      warning.textContent = session.teamsWarning;
      memberships.append(warning);
    }
  } else {
    for (const team of session.teams) {
      const entry = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = `${team.handle} · ${team.name} · ${team.role}`;
      const fields = document.createElement("dl");
      fields.className = "session-details";
      for (const [label, value] of [
        ["Coordinator", team.coordinator],
        ["Contribution", team.scope || "Not specified"],
        ["Joined", observedTime(team.joinedAt)],
        ["Shared scratchpad", team.scratchpad],
      ]) {
        const term = document.createElement("dt");
        term.textContent = label;
        const detail = document.createElement("dd");
        detail.textContent = value;
        fields.append(term, detail);
      }
      entry.append(summary, fields);
      memberships.append(entry);
    }
  }
  section.append(memberships);
  if (compact) {
    const more = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "More session details";
    more.append(summary, extra, resume);
    section.append(more);
  } else {
    section.append(resume);
  }
  const history = document.createElement("details");
  const historyTitle = document.createElement("summary");
  const models = session.modelsUsed || [];
  historyTitle.textContent = `Models observed (${models.length})`;
  const explanation = document.createElement("p");
  explanation.className = "hint";
  explanation.textContent =
    "Stored assistant messages across all branches of this transcript. Unrecorded calls are not included; this is not a live-process probe.";
  const modelList = document.createElement("dl");
  modelList.className = "model-history";
  for (const model of models) {
    const name = document.createElement("dt");
    name.textContent = `${model.provider}/${model.model}`;
    const times = document.createElement("dd");
    times.textContent = `First: ${observedTime(model.firstObservedAt)} · Last: ${observedTime(model.lastObservedAt)}`;
    modelList.append(name, times);
  }
  history.append(historyTitle, explanation, modelList);
  section.append(history);
  section.append(
    button("Copy resume command", async () => {
      await navigator.clipboard.writeText(session.resume);
      status("Resume command copied; nothing was executed.");
    }),
  );
  return section;
}
function contactCard(contact, { allowCompose = true, compact = false } = {}) {
  const row = document.createElement("details");
  row.className = "contact";
  const summary = document.createElement("summary");
  summary.textContent =
    contact.handle +
    " · " +
    contact.status +
    (contact.session ? " · " + contact.session.title : "");
  summary.prepend(
    avatar(
      contact.session && !contact.session.handle
        ? contact.session.sessionId
        : contact.handle,
    ),
  );
  const content = document.createElement("div");
  content.className = "contact-content";
  row.append(summary);
  if (/^@?\+?[A-Za-z0-9._-]+$/.test(contact.handle)) {
    row.append(
      button("Show mail", () =>
        navigate("all", true, "with:" + contact.handle),
      ),
    );
  }
  if (allowCompose) {
    const compose = button("Message " + contact.handle, async () => {
      await newDraft();
      $("to").value = contact.handle;
      renderRecipientCards();
      changed();
      $("body").focus();
    });
    compose.disabled = !contact.addressable;
    row.append(compose);
  }
  if (contact.transcriptAvailable) {
    row.append(
      button("View transcript", () => {
        window.open(
          `/transcript.html?handle=${encodeURIComponent(contact.handle)}`,
          "_blank",
          "noopener",
        );
      }),
    );
  }
  row.append(content);
  let loaded = false;
  row.addEventListener("toggle", async () => {
    if (!row.open || loaded) return;
    loaded = true;
    if (contact.human) {
      content.textContent =
        contact.handle === "@josh"
          ? "Your human inbox; not an agent session."
          : "Human contact; no agent session details.";
      return;
    }
    content.textContent = "Loading session details…";
    try {
      const sessions = contact.session
        ? [contact.session]
        : await api("contact?handle=" + encodeURIComponent(contact.handle));
      content.replaceChildren(
        ...sessions.map((session) => sessionDetails(session, compact)),
      );
      if (!sessions.length)
        content.textContent =
          "Historical contact; no registered session transcript is available.";
      if (contact.lastSeen) {
        const lastSeen = document.createElement("p");
        lastSeen.className = "metadata";
        lastSeen.textContent =
          "Last heartbeat: " + date(contact.lastSeen * 1000);
        content.append(lastSeen);
      }
    } catch (e) {
      loaded = false;
      content.textContent = e.message;
    }
  });
  return row;
}
// The directory is built when it is on screen. It loads with the inbox for compose suggestions,
// but drawing every card into a hidden section cost the first screen for nothing.
let contactsDrawn = false;
function renderContacts() {
  if ($("contacts").hidden) {
    contactsDrawn = false;
    return;
  }
  contactsDrawn = true;
  $("contact-list").replaceChildren();
  for (const contact of contacts) {
    const card = contactCard(contact);
    $("contact-list").append(card);
    if (contact.session) card.open = true;
  }
}
let teamGeneration = 0;
async function getTeams(query = "") {
  const generation = ++teamGeneration;
  $("team-status").textContent = "Loading teams…";
  $("team-list").replaceChildren();
  try {
    const teams = await api("teams?q=" + encodeURIComponent(query));
    if (generation !== teamGeneration) return;
    $("team-list").replaceChildren(...teams.map((team) => teamCard(team)));
    const active = teams.filter((team) => team.status === "active").length;
    $("team-status").textContent = teams.length
      ? `${teams.length} ${teams.length === 1 ? "team" : "teams"} · ${active} active · ${teams.length - active} archived`
      : query
        ? "No teams match this search."
        : "No teams found. Create one with agent-team.";
    if (view === "teams") status("Team directory refreshed.");
  } catch (e) {
    if (generation !== teamGeneration) return;
    $("team-status").textContent = "Team lookup unavailable: " + e.message;
    throw e;
  }
}
function teamCard(team, { allowCompose = true } = {}) {
  const row = document.createElement("details");
  row.className = "team-card";
  const members = team.members.filter((member) => member.leftAt === null);
  const summary = document.createElement("summary");
  summary.textContent = `${team.handle} · ${team.name} · ${team.status} · ${members.length} ${members.length === 1 ? "member" : "members"}`;
  summary.prepend(teamBadge(team));
  row.append(summary);
  const fields = document.createElement("dl");
  fields.className = "session-details";
  const when = (value) => date(value) || "Time not recorded";
  for (const [label, value] of [
    ["Purpose", team.purpose || "Not specified"],
    ["Coordinator", team.coordinator],
    ["Shared scratchpad", team.scratchpad],
    ["Created", when(team.createdAt)],
    ["Updated", when(team.updatedAt)],
  ]) {
    const term = document.createElement("dt");
    term.textContent = label;
    const detail = document.createElement("dd");
    detail.textContent = value;
    fields.append(term, detail);
  }
  row.append(fields);
  if (allowCompose) {
    const message = button("Message team", async () => {
      await newDraft();
      $("to").value = team.handle;
      renderRecipientCards();
      changed();
      $("body").focus();
    });
    message.disabled = team.status !== "active";
    row.append(message);
  }
  const heading = document.createElement("h3");
  heading.textContent =
    team.status === "active" ? "Current members" : "Retained roster";
  row.append(heading);
  for (const member of members) {
    const entry = document.createElement("div");
    const details = document.createElement("p");
    details.className = "metadata";
    details.textContent = `Contribution: ${member.scope || "Not specified"} · Joined: ${when(member.joinedAt)}`;
    entry.append(
      contactCard(
        {
          handle: member.handle,
          status: member.handle === team.coordinator ? "Coordinator" : "Member",
        },
        { allowCompose: false },
      ),
      details,
    );
    row.append(entry);
  }
  const history = document.createElement("details");
  const historyTitle = document.createElement("summary");
  historyTitle.textContent = "Team history";
  const events = document.createElement("ul");
  for (const event of team.history) {
    const entry = document.createElement("li");
    const description =
      event.type === "transfer"
        ? `Coordinator: ${event.from} → ${event.to}`
        : event.type === "created"
          ? `Created; coordinator ${event.coordinator}`
          : "Archived";
    entry.textContent = `${when(event.at)} · ${description}`;
    events.append(entry);
  }
  for (const member of team.members.filter(
    (member) => member.leftAt !== null,
  )) {
    const entry = document.createElement("li");
    entry.textContent = `${member.handle} · ${member.scope || "No contribution specified"} · Joined: ${when(member.joinedAt)} · Left: ${when(member.leftAt)}`;
    events.append(entry);
  }
  history.append(historyTitle, events);
  row.append(history);
  return row;
}
function renderRecipientCards(inspectUnknown = true) {
  const target = $("recipient-cards");
  const previous = new Map(
    [...target.children].map((card) => [card.dataset.recipient, card]),
  );
  const addresses = [...new Set(
    $("to").value.split(",").map((address) => address.trim()).filter(Boolean),
  )];
  const cards = addresses.map((address) => {
    const existing = previous.get(address);
    if (existing && !(inspectUnknown && address.startsWith("@team/") && !existing.dataset.inspected)) {
      if (inspectUnknown && existing.matches("details.contact"))
        existing.open = true;
      return existing;
    }
    let card;
    if (address.startsWith("@team/")) {
      card = document.createElement("div");
      card.textContent = address + " · Leave the To field to inspect this team.";
      if (inspectUnknown) {
        card.dataset.inspected = "true";
        card.textContent = address + " · Loading team details…";
        api("teams?q=" + encodeURIComponent(address)).then((teams) => {
          if (!card.isConnected) return;
          const team = teams.find((team) => team.handle === address);
          if (!team) {
            card.textContent = address + " · No matching team.";
            return;
          }
          const details = teamCard(team, { allowCompose: false });
          details.open = true;
          card.replaceChildren(details);
        }).catch((failure) => {
          card.textContent = address + " · Team details unavailable: " + failure.message;
        });
      }
    } else {
      const known = contacts.find(
        (contact) => contact.handle.toLowerCase() === address.toLowerCase(),
      );
      const human = avatarKey(address).startsWith("human:");
      // Keep the exact recipient, including a session suffix, for inspection;
      // avatar normalization must not retarget an explicit session address.
      card = contactCard(
        { handle: address, human, status: human ? "Human" : known?.status || "Agent" },
        { allowCompose: false, compact: true },
      );
      card.open = inspectUnknown || Boolean(known) || human;
    }
    card.dataset.recipient = address;
    return card;
  });
  target.replaceChildren(...cards);
  if (!cards.length)
    target.textContent = "Select recipients to see their contact details.";
}
function renderParticipantCards(messages) {
  const people = new Map();
  for (const address of messages.flatMap((message) => [
    message.from,
    ...message.to.split(","),
  ])) {
    if (!address.trim()) continue;
    const key = avatarKey(address);
    const human = key.startsWith("human:");
    people.set(key, {
      handle: (human ? "@" : "@+") + key.slice(6),
      human,
      status: human ? "Human" : "Agent",
      transcriptAvailable: !human,
    });
  }
  $("participant-cards").replaceChildren();
  // Eager session inspection blocks reader assets and subsequent message opens
  // on the serial bridge; expand a participant only when details are wanted.
  for (const contact of people.values()) {
    const card = contactCard(contact, { allowCompose: false, compact: true });
    $("participant-cards").append(card);
  }
}

async function renderMarkdown(source, target, remote = false) {
  const ticket = String(++renderCounter);
  target.dataset.renderTicket = ticket;
  // The reader frame starts loading now, so its document and the Markdown work below overlap
  // rather than taking turns on every message opened.
  const frame = document.createElement("iframe");
  frame.title = "Rendered Markdown message";
  frame.className = "rendered";
  frame.sandbox = "allow-scripts allow-popups allow-popups-to-escape-sandbox";
  // The reader has its own restrictive CSP and opaque origin, with no API token.
  frame.src = "/reader.html" + (remote ? "?remote=1" : "");
  const loaded = new Promise((resolve) => (frame.onload = resolve));
  target.append(frame);
  const renderer = new marked.Renderer();
  renderer.html = ({ text }) => escape(text);
  // Remove image sources before constructing any DOM, so blocked images cannot leak a request.
  const images = [];
  renderer.image = ({ href, text }) => {
    images.push({ href, text });
    return '<span data-mail-image="' + (images.length - 1) + '"></span>';
  };
  const clean = DOMPurify.sanitize(
    marked.parse(source, { renderer, async: false }),
    {
      USE_PROFILES: { html: true },
      FORBID_TAGS: [
        "style",
        "form",
        "input",
        "button",
        "iframe",
        "object",
        "embed",
        "video",
        "audio",
      ],
    },
  );
  const doc = new DOMParser().parseFromString(clean, "text/html");
  for (const el of doc.querySelectorAll("[data-mail-image]")) {
    const image = images[Number(el.dataset.mailImage)];
    if (!image) {
      el.remove();
      continue;
    }
    let src = "";
    const local = image.href.match(
      /^(?:attachment:|file:\/\/\/[^?#]*\/attachments\/)([0-9a-f]{32}\.(?:png|jpg|gif|webp))$/,
    );
    if (local) {
      try {
        const response = await fetch("/api/attachment?name=" + local[1], {
          headers: { "X-Agent-Mail-Token": token },
        });
        if (!response.ok) throw new Error("Image unavailable");
        const blob = await response.blob();
        src = await new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(r.result);
          r.onerror = reject;
          r.readAsDataURL(blob);
        });
      } catch {
        /* The placeholder remains useful if an attachment was removed. */
      }
    } else if (remote && /^https:\/\//i.test(image.href)) src = image.href;
    if (src) {
      const img = doc.createElement("img");
      img.setAttribute("src", src);
      img.alt = image.text;
      el.replaceWith(img);
    } else
      el.textContent =
        "[Image: " +
        image.text +
        " · " +
        (image.href.startsWith("https:")
          ? "remote image blocked"
          : "attach a local image to view it") +
        "]";
  }
  const dark = matchMedia("(prefers-color-scheme:dark)").matches;
  const diagrams = doc.querySelectorAll("pre > code.language-mermaid");
  // Mermaid is a megabyte of renderer for a message feature most threads never use,
  // so the bundle is fetched only when a message actually carries a diagram. A failed
  // load leaves the diagram's source visible rather than failing the whole message.
  if (diagrams.length) {
    try {
      const mermaid = await ensureMermaid();
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: dark ? "dark" : "neutral",
        htmlLabels: false,
        flowchart: { htmlLabels: false },
        maxTextSize: 20000,
        suppressErrorRendering: true,
      });
      for (const code of diagrams) {
        try {
          const { svg } = await mermaid.render(
            "mail-diagram-" + ++renderCounter,
            code.textContent,
          );
          const container = doc.createElement("div");
          container.innerHTML = DOMPurify.sanitize(svg, {
            USE_PROFILES: { svg: true, svgFilters: true },
          });
          code.parentNode.replaceWith(container);
        } catch {
          code.parentNode.insertAdjacentText(
            "beforebegin",
            "Diagram could not be rendered; source follows.",
          );
        }
      }
    } catch {
      for (const code of diagrams)
        code.parentNode.insertAdjacentText(
          "beforebegin",
          "Diagram renderer unavailable; source follows.",
        );
    }
  }
  for (const a of doc.querySelectorAll("a")) {
    if (!/^(https?:|mailto:|#)/i.test(a.getAttribute("href") || ""))
      a.removeAttribute("href");
    a.target = "_blank";
    a.rel = "noopener noreferrer";
  }
  if (target.dataset.renderTicket !== ticket) {
    frame.remove();
    return;
  }
  // Everything but the new frame goes; moving the frame itself would make it load again.
  for (const child of [...target.children]) if (child !== frame) child.remove();
  const tools = document.createElement("div");
  tools.className = "render-tools";
  if (images.some((i) => /^https:\/\//i.test(i.href)))
    tools.append(
      button(
        remote
          ? "Block remote images"
          : "Load remote images (contacts external servers)",
        () => renderMarkdown(source, target, !remote),
      ),
    );
  const sourceView = document.createElement("pre");
  sourceView.className = "source";
  sourceView.hidden = true;
  sourceView.textContent = source;
  tools.append(
    button("Markdown source", () => {
      sourceView.hidden = !sourceView.hidden;
    }),
  );
  // The frame sizes itself to its content, so this pins it to a viewport-tall scroller and back.
  tools.append(
    button("Expand / shrink", () => {
      frame.dataset.fixed = frame.dataset.fixed ? "" : "1";
      frame.style.height = frame.dataset.fixed ? "80vh" : frame.dataset.auto || "";
    }),
  );
  tools.classList.add("frame-tools");
  // The message comes first and its tools after it: they are for the occasional look at the
  // source, not the first thing to read.
  frame.after(tools, sourceView);
  await loaded;
  if (target.dataset.renderTicket !== ticket) return;
  frame.contentWindow.postMessage({ type: "render", html: doc.body.innerHTML, dark }, "*");
}

$("compose").onclick = () => newDraft().catch(error);
$("compose-mobile").onclick = () => newDraft().catch(error);
$("mail-button").onclick = () => navigate(folder).catch(error);
$("nav-toggle").onclick = () =>
  setNavOpen(!document.body.classList.contains("nav-open"));
$("nav-backdrop").onclick = () => setNavOpen(false);
$("search-toggle").onclick = () => {
  const open = !document.body.classList.contains("search-open");
  document.body.classList.toggle("search-open", open);
  if (open) $("search").focus();
};
$("refresh").onclick = () => {
  const update =
    view === "teams"
      ? getTeams($("team-search").value)
      : view === "contacts"
        ? getContacts($("contact-search").value)
        : refresh();
  update.catch(error);
};
$("search-form").onsubmit = (e) => {
  e.preventDefault();
  navigate("all", false).catch(error);
};
document
  .querySelectorAll("[data-folder]")
  .forEach((b) => (b.onclick = () => navigate(b.dataset.folder).catch(error)));
$("back").onclick = () => {
  ++threadGeneration;
  show("mail-list");
};
$("archive").onclick = () => archiveThread().catch(error);
$("reply").onclick = () => newDraft("reply").catch(error);
$("reply-all").onclick = () => newDraft("reply-all").catch(error);
$("save-draft").onclick = () => saveDraft().catch(error);
$("close-draft").onclick = () => navigate("drafts").catch(error);
$("send").onclick = () => sendDraft().catch(error);
$("spawn").onclick = () => spawnAgent().catch(error);
$("delete-draft").onclick = () => deleteDraft().catch(error);
for (const id of ["to", "subject"]) $(id).addEventListener("input", changed);
$("to").addEventListener("input", () => renderRecipientCards(false));
$("to").addEventListener("change", () => renderRecipientCards());
$("image").onchange = () => attach().catch(error);
$("preview-button").onclick = async () => {
  $("preview").hidden = false;
  renderMarkdown((await ensureComposer()).value(), $("preview")).catch(error);
};
$("contacts-button").onclick = async () => {
  try {
    if (view === "editor") await saveDraft();
    show("contacts");
    if (!contactsDrawn && contacts.length) renderContacts();
    await getContacts($("contact-search").value);
  } catch (e) {
    error(e);
  }
};
$("contact-search-form").onsubmit = (e) => {
  e.preventDefault();
  getContacts($("contact-search").value).catch(error);
};
$("all-contacts").onclick = () => {
  $("contact-search").value = "";
  getContacts().catch(error);
};
$("teams-button").onclick = async () => {
  try {
    if (view === "editor") await saveDraft();
    ++threadGeneration;
    show("teams");
    await getTeams($("team-search").value);
  } catch (e) {
    error(e);
  }
};
$("team-search-form").onsubmit = (e) => {
  e.preventDefault();
  getTeams($("team-search").value).catch(error);
};
$("all-teams").onclick = () => {
  $("team-search").value = "";
  getTeams().catch(error);
};
$("help-button").onclick = () => $("help").showModal();
window.addEventListener("beforeunload", (e) => {
  if (dirty) {
    e.preventDefault();
    e.returnValue = "";
  }
});
document.addEventListener("keydown", (e) => {
  if (busy || e.isComposing || document.querySelector("dialog[open]")) return;
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && view === "editor") {
    e.preventDefault();
    sendDraft().catch(error);
    return;
  }
  if (
    e.ctrlKey ||
    e.metaKey ||
    e.altKey ||
    (e.target instanceof Element &&
      e.target.closest("input,textarea,select,[contenteditable]"))
  )
    return;
  if (e.key === "Escape" && document.body.classList.contains("nav-open")) {
    setNavOpen(false);
    return;
  }
  // Arrows move through the list as j and k do. In a conversation they keep scrolling it, which
  // is what a reader expects from them; j and k still step between conversations there.
  const key =
    view === "mail-list" && e.key === "ArrowDown"
      ? "j"
      : view === "mail-list" && e.key === "ArrowUp"
        ? "k"
        : e.key === "Escape"
          ? "u"
          : e.key;
  if (prefix === "g" && Date.now() - prefixAt < 1500) {
    prefix = "";
    const f = {
      i: "inbox", a: "all", s: "sent", d: "drafts",
      c: "contacts", t: "teams",
    }[key];
    if (f) {
      e.preventDefault();
      if (f === "contacts" || f === "teams") $(f + "-button").click();
      else navigate(f).catch(error);
      return;
    }
  }
  if (key === "g") {
    prefix = "g";
    prefixAt = Date.now();
    return;
  }
  if (key === "?") {
    $("help").showModal();
    e.preventDefault();
  } else if (key === "/") {
    document.body.classList.add("search-open");
    $("search").focus();
    e.preventDefault();
  } else if (key === "c") {
    e.preventDefault();
    newDraft().catch(error);
  } else if (key === "u" && view === "reader") {
    $("back").click();
    e.preventDefault();
  } else if (key === "e" && ["mail-list", "reader"].includes(view)) {
    e.preventDefault();
    archiveThread().catch(error);
  } else if ((key === "r" || key === "a") && view === "reader") {
    e.preventDefault();
    newDraft(key === "r" ? "reply" : "reply-all").catch(error);
  } else if (view === "reader" && (key === "j" || key === "k")) {
    e.preventDefault();
    openItem(
      Math.max(
        0,
        Math.min(items.length - 1, selected + (key === "j" ? 1 : -1)),
      ),
    ).catch(error);
  } else if (view === "mail-list") {
    if (key === "j" || key === "k") {
      e.preventDefault();
      selected = Math.max(
        0,
        Math.min(items.length - 1, selected + (key === "j" ? 1 : -1)),
      );
      markSelected();
      $("rows").querySelectorAll(".row")[selected]?.focus();
      prefetch(selected);
    } else if (key === "o" || (key === "Enter" && e.target === document.body)) {
      e.preventDefault();
      openItem().catch(error);
    }
  }
});
$("current-user").prepend(avatar("@josh"));
// This document's own base entry. History state survives a reload, so whatever the entry held
// before belongs to the old document.
history.replaceState({ agentMail: "base" }, "");
show("mail-list");
if (!token) showAuthorize();
$("authorize-form").onsubmit = (event) => {
  event.preventDefault();
  authorize($("authorize-input").value).catch(error);
};
// The bridge answers one request at a time, so the list goes first and everything the first
// screen does not need waits until it has drawn. Asked for together, the inbox queued behind the
// contact directory, the team roster, and the notifier's own copy of the inbox.
refresh()
  .catch(error)
  .finally(() => {
    // The realm distinguishes one machine's inbox from another; the bridge reads it locally.
    api("config")
      .then((config) => {
        if (!config.realm) return;
        const realm = $("realm");
        realm.textContent = config.realm;
        realm.hidden = false;
      })
      .catch(() => {});
    getContacts().catch(error);
    // Badges are decoration: a failed team lookup leaves plain avatars.
    loadTeamBadges().catch(() => {});
    checkNewMail().catch(() => {});
  });
setInterval(() => loadTeamBadges().catch(() => {}), 300000);
function refreshVisible() {
  // Not while an archive or send is in flight: a poll landing between its requests would draw
  // the half-moved conversation back into the list for a moment.
  if (document.hidden || busy) return;
  if (!$("mail-list").hidden) refresh(true).catch(error);
  // The thread stays visible beside an inline reply draft, and beside the list when split.
  if (current && !$("reader").hidden) refreshThread().catch(error);
}
setInterval(refreshVisible, 10000);
// A hidden page is the normal state on a phone, and the interval above does nothing
// while hidden, so returning to the app would otherwise show mail up to a full interval
// old. The transcript view already refreshes on becoming visible; this is the same rule.
document.addEventListener("visibilitychange", refreshVisible);

// iOS and Android float a fixed bottom bar above the on-screen keyboard, where it covers
// the composer. A keyboard shrinks the visual viewport by far more than a URL bar moves
// when it hides, so the bar stands down whenever the viewport drops well below the tallest
// one seen. Tracking the maximum rather than window.innerHeight also covers Android
// resizing the layout viewport instead of only the visual one. The CSS does the hiding.
const viewport = window.visualViewport;
if (viewport) {
  let tallest = viewport.height;
  const syncKeyboard = () => {
    if (!document.body.classList.contains("keyboard-open"))
      tallest = Math.max(tallest, viewport.height);
    document.body.classList.toggle(
      "keyboard-open",
      viewport.height < tallest - 150,
    );
  };
  viewport.addEventListener("resize", syncKeyboard);
  viewport.addEventListener("scroll", syncKeyboard);
  syncKeyboard();
}

// Notifications need a running bridge and an open app window (even in the
// background); nothing here can deliver mail while the app is closed.
const worker =
  "serviceWorker" in navigator
    ? navigator.serviceWorker.register("/sw.js").catch(() => null)
    : Promise.resolve(null);
let seenInbox = null;
let inboxVersion = "";
function notifyState() {
  const b = $("notify-button");
  b.hidden = !("Notification" in window) || Notification.permission !== "default";
}
async function checkNewMail() {
  const allowed =
    typeof Notification !== "undefined" && Notification.permission === "granted";
  // Tells the bridge this window will notify, so terminal banners stand down. The heartbeat is
  // recorded even when the inbox is unchanged and the reply is only its stamp.
  const result = await api(
    "messages?folder=inbox&q=" + (inboxVersion ? "&version=" + inboxVersion : ""),
    undefined,
    allowed ? { "X-Agent-Mail-Notifier": "1" } : {},
  );
  if (result.unchanged) return;
  inboxVersion = result.version;
  const { messages } = result;
  const keys = new Set(messages.map((m) => m.key));
  const fresh = seenInbox ? messages.filter((m) => !seenInbox.has(m.key)) : [];
  seenInbox = keys;
  const focused = !document.hidden && document.hasFocus();
  if (!fresh.length || focused || !allowed) return;
  const registration = await worker;
  for (const m of fresh.slice(0, 5)) {
    const title = "Mail from " + (m.from || "unknown sender");
    const options = {
      body: m.subject || "(no subject)",
      tag: m.key,
      data: { key: m.key, subject: m.subject },
      icon: "/icon-192.png",
    };
    if (registration) await registration.showNotification(title, options);
    else
      new Notification(title, options).onclick = () =>
        openMail(options.data).catch(error);
  }
}
async function openMail(message) {
  window.focus();
  if (view === "editor") await saveDraft();
  await openThread(message);
}
navigator.serviceWorker?.addEventListener("message", (event) => {
  if (event.data?.type === "open") openMail(event.data).catch(error);
});
$("copy-thread-id").onclick = () => copyId($("thread-id").textContent);
$("notify-button").onclick = () =>
  Notification.requestPermission().then(notifyState).catch(error);
notifyState();
// Background windows are throttled to about once a minute, which is enough here.
setInterval(() => checkNewMail().catch(() => {}), 30000);
const opening = new URLSearchParams(location.search).get("open");
if (opening) {
  history.replaceState({ agentMail: "base" }, "", "/");
  openMail({ key: opening }).catch(error);
}

window.addEventListener("message", (event) => {
  const frame = [...document.querySelectorAll("iframe.rendered")].find(
    (f) => f.contentWindow === event.source,
  );
  if (!frame || event.origin !== "null") return;
  if (event.data?.type === "height" && Number.isFinite(event.data.height)) {
    // A short message gets a short frame; the old 150px floor left most replies in a tall box.
    const height = Math.min(12000, Math.max(48, event.data.height + 16)) + "px";
    frame.dataset.auto = height;
    if (!frame.dataset.fixed) frame.style.height = height;
    frame.classList.add("sized");
    if (frame.closest("#thread")) scrollToLatestMessage();
  }
  if (
    event.data?.type === "key" &&
    ["j", "k", "o", "u", "e", "r", "a", "?", "/", "g", "i", "s", "d"].includes(
      event.data.key,
    )
  )
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: event.data.key }),
    );
});
