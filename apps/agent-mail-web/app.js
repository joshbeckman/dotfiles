"use strict";
const $ = (id) => document.getElementById(id);
const { marked, DOMPurify, mermaid } = MailRenderers;
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
const status = (text, error = false) => {
  $("status").textContent = text;
  $("status").classList.toggle("error", error);
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
const date = (value) => {
  const d = new Date(value);
  return Number.isNaN(+d)
    ? ""
    : d.toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
};
const composer = MailComposer.create($("body-editor"), changed, error);
let keywordGeneration = 0;
async function loadKeywords() {
  const generation = ++keywordGeneration;
  $("keyword-status").textContent = "Loading local keywords…";
  try {
    const result = await api("keywords");
    if (generation !== keywordGeneration) return;
    composer.keywords(result.words);
    $("keyword-status").textContent = result.available
      ? `${result.words.length} local keyword${result.words.length === 1 ? "" : "s"} · Ctrl+n / Ctrl+p to complete, Tab to accept`
      : "No local keywords.txt found; editor remains available.";
  } catch (e) {
    if (generation !== keywordGeneration) return;
    composer.keywords([]);
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
function show(name) {
  view = name;
  const replying = name === "editor" && Boolean(draft?.parent);
  document.querySelector("main").classList.toggle("replying", replying);
  for (const id of ["mail-list", "reader", "editor", "contacts", "teams"])
    $(id).hidden = id !== name && !(replying && id === "reader");
  setFolderButtons();
  if (name === "editor") renderRecipientCards();
}
function button(text, action) {
  const b = document.createElement("button");
  b.textContent = text;
  b.onclick = () => Promise.resolve().then(action).catch(error);
  return b;
}
function setFolderButtons() {
  document
    .querySelectorAll("[data-folder]")
    .forEach((b) =>
      b.setAttribute(
        "aria-current",
        b.dataset.folder === folder && !["contacts", "teams"].includes(view)
          ? "page"
          : "false",
      ),
    );
  for (const name of ["contacts", "teams"])
    $(name + "-button").setAttribute(
      "aria-current",
      view === name ? "page" : "false",
    );
}
async function refresh(quiet = false) {
  const generation = ++listGeneration;
  const result = await api(
    "messages?folder=" + folder + "&q=" + encodeURIComponent($("search").value),
  );
  if (generation !== listGeneration) return;
  const selectedKey = items[selected]?.key;
  const grouped = new Map();
  for (const m of result.messages) {
    const group = m.folder === "drafts" ? m.key : m.thread;
    if (!grouped.has(group)) grouped.set(group, { ...m, count: 0 });
    grouped.get(group).count++;
  }
  const nextItems = [...grouped.values()];
  const listChanged = JSON.stringify(items) !== JSON.stringify(nextItems);
  items = nextItems;
  selected = Math.max(
    0,
    items.findIndex((m) => m.key === selectedKey),
  );
  for (const f of ["inbox", "archive", "sent", "drafts"])
    $("count-" + f).textContent = result.counts[f] || "";
  $("folder-title").textContent = $("search").value
    ? "Search results"
    : folder[0].toUpperCase() + folder.slice(1);
  if (listChanged || !$("rows").children.length) renderList();
  if (result.warnings.length) status(result.warnings.join("; "), true);
  else if (!quiet)
    status(
      items.length +
        (items.length === 1 ? " conversation" : " conversations") +
        " · synced with local files",
    );
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
        if (!response.ok) return "";
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
  const hash = hashOf(key);
  const hue = (hash >>> 16) % 360;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="hsl(${hue} 30% 93%)"/>`;
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 5; x++) {
      if ((hash >>> (y * 3 + Math.min(x, 4 - x))) & 1 || (x === 2 && y === 2))
        svg += `<rect x="${6 + x * 4}" y="${6 + y * 4}" width="3.5" height="3.5" rx="0.5" fill="hsl(${hue} 65% 35%)"/>`;
    }
  }
  const fallback = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg + "</svg>");
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
function renderList() {
  const rows = $("rows");
  rows.replaceChildren();
  if (!items.length) {
    rows.textContent = "No messages here.";
    return;
  }
  items.forEach((m, i) => {
    const row = button("", () => openItem(i));
    row.className = "row" + (i === selected ? " selected" : "");
    row.innerHTML =
      '<span class="sender">' +
      escape(m.from || "Draft") +
      "</span><span><strong>" +
      escape(m.subject || "(no subject)") +
      "</strong>" +
      (m.count > 1 ? " (" + m.count + ")" : "") +
      '<span class="excerpt">' +
      escape(m.excerpt) +
      "</span></span><time>" +
      escape(date(m.date)) +
      "</time>";
    row.querySelector(".sender").prepend(avatar(m.from || "josh"));
    rows.append(row);
  });
}
async function navigate(target, clearSearch = true, query = "") {
  if (view === "editor") await saveDraft();
  ++threadGeneration;
  folder = target;
  if (clearSearch) $("search").value = query;
  setFolderButtons();
  show("mail-list");
  await refresh();
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
  const messages = await api("thread?key=" + encodeURIComponent(m.key));
  if (generation !== threadGeneration) return false;
  const key =
    m.folder === "drafts"
      ? messages.find((message) => message.id === m.parent)?.key ||
        messages.at(-1)?.key ||
        m.key
      : m.key;
  current = { key, messages };
  $("thread-title").textContent = m.subject || "(no subject)";
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
  const known = new Set(open.messages.map((v) => v.key));
  const fresh = messages.filter((v) => !known.has(v.key));
  if (!fresh.length) return;
  if (!open.messages.length) $("thread").replaceChildren();
  for (const message of fresh) appendThreadMessage(message, true);
  current = { ...open, messages };
  threadSummary(messages);
  const senders = [...new Set(fresh.map((v) => v.from))].join(", ");
  status(`New ${fresh.length === 1 ? "message" : "messages"} from ${senders}.`);
}
// Attach before rendering: the sandboxed reader frame sizes itself once loaded.
function appendThreadMessage(message, open) {
  const detail = document.createElement("details");
  detail.className = "message";
  detail.open = open;
  const summary = document.createElement("summary");
  summary.innerHTML =
    "<time>" +
    escape(date(message.date)) +
    "</time>" +
    escape(message.from) +
    " · " +
    escape(message.folder);
  summary.querySelector("time").after(avatar(message.from));
  detail.append(summary);
  const metadata = document.createElement("p");
  metadata.className = "metadata";
  metadata.textContent =
    "To: " +
    message.to +
    (message.parent ? " · In reply to " + message.parent : "");
  detail.append(metadata);
  const content = document.createElement("div");
  detail.append(content);
  $("thread").append(detail);
  let rendered = false;
  const render = () => {
    if (!rendered && detail.open) {
      rendered = true;
      renderMarkdown(message.body, content).catch(error);
    }
  };
  detail.addEventListener("toggle", render);
  render();
  const actions = document.createElement("div");
  actions.className = "render-tools";
  actions.append(
    button("Reply to this message", () => newDraft("reply", message.key)),
    button("Reply all", () => newDraft("reply-all", message.key)),
  );
  detail.append(actions);
}
async function archiveThread() {
  if (busy) return;
  busy = true;
  try {
    const messages =
      view === "reader" && current
        ? current.messages
        : items[selected]
          ? await api("thread?key=" + encodeURIComponent(items[selected].key))
          : [];
    for (const m of messages.filter((m) => m.folder === "inbox"))
      await api("archive", { key: m.key });
    show("mail-list");
    await refresh();
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
  composer.load(value.body);
  loadKeywords();
  $("preview").hidden = true;
  $("preview").replaceChildren();
  $("draft-status").textContent = "Saved on disk";
  if (value.parent && !(await openThread(value))) return;
  show("editor");
  if (value.to) composer.focus();
  else $("to").focus();
}
function saveDraft() {
  clearTimeout(timer);
  saving = saving
    .catch(() => {})
    .then(async () => {
      while (draft && dirty) {
        const old = draft;
        const fields = {
          to: $("to").value,
          subject: $("subject").value,
          body: composer.value(),
        };
        const result = await api("save", {
          key: old.key,
          revision: old.revision,
          ...fields,
        });
        if (draft === old) {
          draft = result;
          dirty = Object.entries(fields).some(
            ([k, v]) => (k === "body" ? composer.value() : $(k).value) !== v,
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
  composer.readOnly(true);
  try {
    await saveDraft();
    const sent = await api("send", {
      key: draft.key,
      revision: draft.revision,
    });
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
    composer.readOnly(false);
    if (view === "reader" && current)
      $("archive").disabled = !current.messages.some(
        (m) => m.folder === "inbox",
      );
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
  composer.readOnly(true);
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
    composer.readOnly(false);
  }
}
async function attach() {
  const file = $("image").files[0];
  if (!file || uploading) return;
  if (file.size > 5 * 1024 * 1024)
    throw new Error("Images must be at most 5 MiB");
  const key = draft?.key;
  uploading = true;
  try {
    const data = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result.split(",")[1]);
      r.onerror = reject;
      r.readAsDataURL(file);
    });
    const result = await api("attachment", { data });
    if (draft?.key !== key || view !== "editor")
      throw new Error(
        "Draft changed during image upload. Attach it again to the intended message.",
      );
    composer.insert(
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
  const observedTime = (value) => {
    const timestamp = value ? new Date(value) : null;
    return timestamp && !Number.isNaN(+timestamp)
      ? timestamp.toLocaleString()
      : "Time not recorded";
  };
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
    ["Started", session.started],
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
function renderContacts() {
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
  const when = (value) => {
    const timestamp = value ? new Date(value) : null;
    return timestamp && !Number.isNaN(+timestamp)
      ? timestamp.toLocaleString()
      : "Time not recorded";
  };
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
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: dark ? "dark" : "neutral",
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    maxTextSize: 20000,
    suppressErrorRendering: true,
  });
  for (const code of doc.querySelectorAll("pre > code.language-mermaid")) {
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
  for (const a of doc.querySelectorAll("a")) {
    if (!/^(https?:|mailto:|#)/i.test(a.getAttribute("href") || ""))
      a.removeAttribute("href");
    a.target = "_blank";
    a.rel = "noopener noreferrer";
  }
  if (target.dataset.renderTicket !== ticket) return;
  target.replaceChildren();
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
  const frame = document.createElement("iframe");
  frame.title = "Rendered Markdown message";
  frame.className = "rendered";
  frame.sandbox = "allow-scripts allow-popups allow-popups-to-escape-sandbox";
  // The reader has its own restrictive CSP and opaque origin, with no API token.
  frame.src = "/reader.html" + (remote ? "?remote=1" : "");
  frame.onload = () =>
    frame.contentWindow.postMessage(
      { type: "render", html: doc.body.innerHTML, dark },
      "*",
    );
  tools.append(
    button(
      "Expand / shrink",
      () => (frame.style.height = frame.style.height ? "" : "80vh"),
    ),
  );
  target.append(tools, frame, sourceView);
}

$("compose").onclick = () => newDraft().catch(error);
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
  renderList();
};
$("archive").onclick = () => archiveThread().catch(error);
$("reply").onclick = () => newDraft("reply").catch(error);
$("reply-all").onclick = () => newDraft("reply-all").catch(error);
$("save-draft").onclick = () => saveDraft().catch(error);
$("close-draft").onclick = () => navigate("drafts").catch(error);
$("send").onclick = () => sendDraft().catch(error);
$("delete-draft").onclick = () => deleteDraft().catch(error);
for (const id of ["to", "subject"]) $(id).addEventListener("input", changed);
$("to").addEventListener("input", () => renderRecipientCards(false));
$("to").addEventListener("change", () => renderRecipientCards());
$("image").onchange = () => attach().catch(error);
$("preview-button").onclick = () => {
  $("preview").hidden = false;
  renderMarkdown(composer.value(), $("preview")).catch(error);
};
$("contacts-button").onclick = async () => {
  try {
    if (view === "editor") await saveDraft();
    show("contacts");
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
  const key = e.key;
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
      renderList();
      $("rows").children[selected]?.focus();
    } else if (key === "o" || (key === "Enter" && e.target === document.body)) {
      e.preventDefault();
      openItem().catch(error);
    }
  }
});
$("current-user").prepend(avatar("@josh"));
if (!token) showAuthorize();
$("authorize-form").onsubmit = (event) => {
  event.preventDefault();
  authorize($("authorize-input").value).catch(error);
};
refresh().catch(error);
getContacts().catch(error);
// Badges are decoration: a failed team lookup leaves plain avatars.
loadTeamBadges().catch(() => {});
setInterval(() => loadTeamBadges().catch(() => {}), 300000);
setInterval(() => {
  if (document.hidden) return;
  if (view === "mail-list") refresh(true).catch(error);
  // The thread stays visible beside an inline reply draft.
  else if (current && !$("reader").hidden) refreshThread().catch(error);
}, 10000);

// Notifications need a running bridge and an open app window (even in the
// background); nothing here can deliver mail while the app is closed.
const worker =
  "serviceWorker" in navigator
    ? navigator.serviceWorker.register("/sw.js").catch(() => null)
    : Promise.resolve(null);
let seenInbox = null;
function notifyState() {
  const b = $("notify-button");
  b.hidden = !("Notification" in window) || Notification.permission !== "default";
}
async function checkNewMail() {
  const allowed =
    typeof Notification !== "undefined" && Notification.permission === "granted";
  // Tells the bridge this window will notify, so terminal banners stand down.
  const { messages } = await api(
    "messages?folder=inbox&q=",
    undefined,
    allowed ? { "X-Agent-Mail-Notifier": "1" } : {},
  );
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
$("notify-button").onclick = () =>
  Notification.requestPermission().then(notifyState).catch(error);
notifyState();
checkNewMail().catch(() => {});
// Background windows are throttled to about once a minute, which is enough here.
setInterval(() => checkNewMail().catch(() => {}), 30000);
const opening = new URLSearchParams(location.search).get("open");
if (opening) {
  history.replaceState(null, "", "/");
  openMail({ key: opening }).catch(error);
}

window.addEventListener("message", (event) => {
  const frame = [...document.querySelectorAll("iframe.rendered")].find(
    (f) => f.contentWindow === event.source,
  );
  if (!frame || event.origin !== "null") return;
  if (event.data?.type === "height" && Number.isFinite(event.data.height))
    frame.style.height =
      Math.min(12000, Math.max(150, event.data.height + 16)) + "px";
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
