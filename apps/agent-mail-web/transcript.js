"use strict";
const params = new URLSearchParams(location.search);
const handle = params.get("handle") || "";
const token =
  localStorage.getItem("agent-mail-token") ||
  sessionStorage.getItem("agent-mail-token") ||
  "";
const entries = new Map();
let version = null;
let before = null;
let latestEnd = null;
let sessionId = null;
let loading = false;
let olderQueued = false;
let requestNumber = 0;
let controller = null;
let timer = null;
const entryState = new Map();
const disclosureState = new Map();

const $ = (id) => document.getElementById(id);
function status(text, error = false) {
  $("status").textContent = text;
  $("status").classList.toggle("error", error);
}
function text(value) {
  return value == null ? "" : String(value);
}
const relativeTime = new Intl.RelativeTimeFormat(undefined, {
  numeric: "always",
});
function time(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(+date)) return text(value);
  const delta = +date - Date.now();
  const distance = Math.abs(delta);
  if (distance >= 3 * 24 * 60 * 60 * 1000) return date.toLocaleString();
  const [unit, size] =
    distance < 60 * 1000
      ? ["second", 1000]
      : distance < 60 * 60 * 1000
        ? ["minute", 60 * 1000]
        : distance < 24 * 60 * 60 * 1000
          ? ["hour", 60 * 60 * 1000]
          : ["day", 24 * 60 * 60 * 1000];
  const amount = Math.max(1, Math.round(distance / size));
  return relativeTime.format(delta < 0 ? -amount : amount, unit);
}
function addText(parent, value, className = "prose") {
  const block = document.createElement("div");
  block.className = className;
  block.textContent = text(value);
  parent.append(block);
}
function addJson(parent, value) {
  const pre = document.createElement("pre");
  pre.textContent = JSON.stringify(value, null, 2);
  parent.append(pre);
}
function addDisclosure(parent, label, value, open = false) {
  const details = document.createElement("details");
  details.open = open;
  const summary = document.createElement("summary");
  summary.textContent = label;
  details.append(summary);
  typeof value === "string" ? addText(details, value) : addJson(details, value);
  parent.append(details);
}
function renderContent(parent, content) {
  if (typeof content === "string") return addText(parent, content);
  if (!Array.isArray(content)) return addJson(parent, content);
  for (const block of content) {
    if (!block || typeof block !== "object") {
      addText(parent, block);
    } else if (block.type === "text") {
      addText(parent, block.text);
    } else if (block.type === "thinking") {
      addDisclosure(parent, block.redacted ? "Redacted thinking" : "Thinking", block.thinking || "(redacted)");
    } else if (block.type === "toolCall" || block.type === "tool_use") {
      addDisclosure(parent, `Tool call · ${text(block.name)}`, block.arguments ?? block.input ?? {});
    } else if (block.type === "image") {
      addText(parent, `[${text(block.mimeType || "image")} omitted from this journal]`, "metadata");
    } else {
      addDisclosure(parent, `Content · ${text(block.type || "unknown")}`, block);
    }
  }
}
function label(entry) {
  const value = entry.type === "message" ? entry.message?.role || "message" : entry.type;
  return text(value).replaceAll("_", " ");
}
function entryNode(key, entry) {
  const details = document.createElement("details");
  const role = label(entry);
  details.className = `entry role-${role.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
  details.dataset.key = key;
  const defaultOpen = entry.type === "message" && ["user", "assistant", "custom", "bashExecution"].includes(entry.message?.role);
  details.open = entryState.has(key) ? entryState.get(key) : defaultOpen;
  details.addEventListener("toggle", () => entryState.set(key, details.open));
  const summary = document.createElement("summary");
  const heading = document.createElement("strong");
  heading.textContent = role;
  const timestamp = document.createElement("time");
  const timestampValue = entry.timestamp || entry.message?.timestamp;
  timestamp.textContent = time(timestampValue);
  const exactTime = new Date(timestampValue);
  if (!Number.isNaN(+exactTime)) {
    timestamp.dateTime = exactTime.toISOString();
    timestamp.title = exactTime.toLocaleString();
  }
  summary.append(heading, timestamp);
  details.append(summary);
  const body = document.createElement("div");
  body.className = "entry-body";
  if (entry.type === "message") {
    const message = entry.message || {};
    if (message.role === "bashExecution") {
      addText(body, `$ ${text(message.command)}`, "command");
      addText(body, message.output);
    } else if (message.role === "custom") {
      addText(body, message.customType, "metadata");
      renderContent(body, message.content);
    } else {
      renderContent(body, message.content);
    }
    const facts = [message.provider && message.model ? `${message.provider}/${message.model}` : "", message.stopReason || "", message.isError ? "error" : ""].filter(Boolean);
    if (facts.length) addText(body, facts.join(" · "), "metadata");
  } else if (entry.type === "session") {
    addText(body, entry.cwd || "Unknown working directory");
  } else if (entry.type === "model_change") {
    addText(body, `${text(entry.provider)}/${text(entry.modelId)}`);
  } else if (entry.type === "thinking_level_change") {
    addText(body, entry.thinkingLevel);
  } else if (entry.type === "compaction" || entry.type === "branch_summary") {
    addText(body, entry.summary);
  } else if (entry.type === "session_info") {
    addText(body, entry.name || entry.title || "Session metadata");
  } else if (entry.type === "transcript_oversize") {
    addText(body, `${entry.continued ? "A segment of at least" : "An entry of"} ${Number(entry.bytes).toLocaleString()} bytes was omitted to keep this page bounded.`);
  } else {
    addJson(body, entry);
  }
  const lineage = [entry.id && `id ${entry.id}`, entry.parentId && `parent ${entry.parentId}`].filter(Boolean);
  if (lineage.length) addText(body, lineage.join(" · "), "lineage");
  [...body.querySelectorAll("details")].forEach((item, index) => {
    item.dataset.disclosure = `${key}:${index}`;
    const saved = disclosureState.get(item.dataset.disclosure);
    if (saved != null) item.open = saved;
    item.addEventListener("toggle", () => disclosureState.set(item.dataset.disclosure, item.open));
  });
  details.append(body);
  return details;
}
function anchor() {
  const nodes = [...document.querySelectorAll(".entry")];
  const node = nodes.find((item) => item.getBoundingClientRect().bottom > 0);
  return node ? { key: node.dataset.key, top: node.getBoundingClientRect().top } : null;
}
function clearJournal(preserveState = false) {
  entries.clear();
  if (!preserveState) {
    entryState.clear();
    disclosureState.clear();
  }
  $("entries").replaceChildren();
  version = null;
  before = null;
  latestEnd = null;
}
function render(data, older = false) {
  if (sessionId && sessionId !== data.sessionId) clearJournal();
  sessionId = data.sessionId;
  if (data.reset) clearJournal(true);
  const position = anchor();
  const nearBottom = innerHeight + scrollY >= document.documentElement.scrollHeight - 80;
  for (const item of data.entries) entries.set(item.key, item.entry);
  const fragment = document.createDocumentFragment();
  for (const [key, entry] of [...entries].sort((a, b) => Number(a[0]) - Number(b[0])))
    fragment.append(entryNode(key, entry));
  $("entries").replaceChildren(fragment);
  before = data.reset || before == null ? data.before : Math.min(before, data.before);
  $("older").hidden = before <= 0;
  $("session-info").textContent = `${data.handle} · ${data.header.cwd || "unknown cwd"}`;
  document.title = `${data.handle} · Session transcript`;
  if (position) {
    const restored = document.querySelector(`[data-key="${CSS.escape(position.key)}"]`);
    if (restored) scrollBy(0, restored.getBoundingClientRect().top - position.top);
  } else if (!older && nearBottom) {
    scrollTo(0, document.documentElement.scrollHeight);
  }
  if (!older) {
    version = data.version;
    latestEnd = data.end;
  }
  $("empty").textContent = "";
  const notes = [];
  if (data.reset) notes.push("journal advanced beyond the live window; load older entries for the gap");
  if (data.partial) notes.push("waiting for a partial entry to finish");
  if (data.skipped) notes.push(`${data.skipped} unreadable entr${data.skipped === 1 ? "y" : "ies"} skipped`);
  status(`Updated ${new Date().toLocaleTimeString()}${notes.length ? " · " + notes.join(" · ") : ""}`);
}
async function api(query, signal) {
  const response = await fetch(`/api/transcript?${query}`, {
    headers: { "X-Agent-Mail-Token": token },
    signal,
  });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error || "Transcript request failed"), { status: response.status });
  return result;
}
async function load({ older = false } = {}) {
  if (loading) {
    if (older) olderQueued = true;
    return;
  }
  if (document.hidden) return;
  if (!handle) return status("No contact handle was provided.", true);
  loading = true;
  const request = ++requestNumber;
  controller = new AbortController();
  try {
    const query = new URLSearchParams({ handle });
    if (older && before != null) query.set("before", before);
    else if (version) {
      query.set("version", version);
      if (latestEnd != null) query.set("after", latestEnd);
    }
    const data = await api(query, controller.signal);
    if (request !== requestNumber || data.unchanged) return;
    render(data, older);
  } catch (error) {
    if (error.name !== "AbortError") {
      status(error.message, true);
      if ([400, 404, 409, 422].includes(error.status)) clearJournal();
      if (error.status === 403) $("empty").textContent = "Open Agent Mail from its launch URL to authorize this tab.";
      else if (error.status === 404) $("empty").textContent = "No retained Pi transcript is registered for this contact.";
      else $("empty").textContent = error.message;
    }
  } finally {
    loading = false;
    controller = null;
    if (olderQueued && !document.hidden) {
      olderQueued = false;
      load({ older: true });
    }
  }
}
function schedule() {
  clearInterval(timer);
  timer = document.hidden ? null : setInterval(load, 2000);
}
$("older").addEventListener("click", () => load({ older: true }));
document.addEventListener("visibilitychange", () => {
  schedule();
  if (!document.hidden) load();
});
addEventListener("pagehide", () => {
  requestNumber++;
  controller?.abort();
  loading = false;
  clearInterval(timer);
});
addEventListener("pageshow", () => {
  schedule();
  load();
});
load();
schedule();
