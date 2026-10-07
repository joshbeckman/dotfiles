import { chromium } from "playwright-core";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  appendFile,
  rename,
  readdir,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
async function assertReaderFits(reader) {
  await reader.owner().evaluate((frame) => frame.scrollIntoView());
  let size;
  for (let attempt = 0; attempt < 40; attempt++) {
    size = await reader.locator("body").evaluate((body) => ({
      viewport: document.documentElement.clientHeight,
      document: document.documentElement.scrollHeight,
      body: body.scrollHeight,
      top: body.getBoundingClientRect().top,
      bottom: body.getBoundingClientRect().bottom,
    }));
    if (size.document <= size.viewport) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail("Unexpected message scrollbar: " + JSON.stringify(size));
}
const root = resolve("../.."),
  tmp = await mkdtemp(join(tmpdir(), "agent-mail-browser-"));
const bin = join(tmp, "bin"),
  agents = join(tmp, "agents"),
  humans = join(tmp, "humans");
await mkdir(bin);
await mkdir(join(agents, "alder-turner-12345678"), { recursive: true });
await mkdir(join(agents, "birch-weaver-87654321"));
await writeFile(join(bin, "notify-josh"), "#!/bin/sh\nexit 0\n", {
  mode: 0o755,
});
const env = {
  ...process.env,
  PATH: bin + ":" + process.env.PATH,
  AGENT_TEAM_ROOT: join(tmp, "teams"),
  AGENT_MAIL_ROOT: agents,
  AGENT_HUMAN_MAIL_ROOT: humans,
  AGENT_IDENTITIES_DIR: join(tmp, "identities"),
  PI_SESSIONS_DIR: join(tmp, "sessions"),
  XDG_CONFIG_HOME: join(tmp, "config"),
  AGENT_REALM: "testrealm",
};
await mkdir(join(env.XDG_CONFIG_HOME, "nvim"), { recursive: true });
const keywordFile = join(env.XDG_CONFIG_HOME, "nvim/keywords.txt");
await writeFile(keywordFile, "@+alder-turner\n@+alder-weaver\nname.with_dot\n");
await mkdir(env.AGENT_IDENTITIES_DIR);
await mkdir(env.PI_SESSIONS_DIR);
const sid = "12345678-0000-0000-0000-000000000001";
await writeFile(join(env.AGENT_IDENTITIES_DIR, "alder-turner"), sid + "\n");
const sessionFile = join(env.PI_SESSIONS_DIR, "2026-01-01T00-00-00Z_" + sid + ".jsonl");
await writeFile(
  sessionFile,
  [
    { type: "session", version: 3, id: sid, timestamp: "2026-01-01T00:00:00Z", cwd: "/fixture/orchard" },
    { type: "session_info", name: "Investigate orchard migrations" },
    {
      type: "message",
      timestamp: "2026-01-01T00:00:00Z",
      message: {
        role: "assistant",
        provider: "fixture-provider",
        model: "oak-v1",
      },
    },
    {
      type: "message",
      timestamp: "2026-01-02T00:00:00Z",
      message: {
        role: "assistant",
        provider: "fixture-provider",
        model: "cedar-v2",
      },
    },
    { type: "message", id: "fixture-user", parentId: null, timestamp: "2026-01-02T00:01:00Z", message: { role: "user", content: "orchard incident analysis <script>unsafe()</script>", timestamp: 1767312060000 } },
    { type: "message", id: "fixture-assistant", parentId: "fixture-user", timestamp: "2026-01-02T00:02:00Z", message: { role: "assistant", provider: "fixture-provider", model: "cedar-v2", timestamp: 1767312120000, content: [{ type: "text", text: "I will inspect it." }, { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "/fixture/orchard" } }] } },
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n") + "\n",
);
const cli = (...args) =>
  execFileSync(join(root, "bin/agent-mail"), args, {
    env,
    encoding: "utf8",
  }).trim();
const team = (...args) =>
  execFileSync(join(root, "bin/agent-team"), args, { env, encoding: "utf8" });
await writeFile(
  join(env.AGENT_IDENTITIES_DIR, "birch-weaver"),
  "87654321-0000-0000-0000-000000000002\n",
);
team(
  "create",
  "orchard",
  "--coordinator",
  "@+alder-turner",
  "--name",
  "Orchard crew",
);
team(
  "create",
  "review",
  "--coordinator",
  "@+birch-weaver",
  "--name",
  "Review group",
);
team(
  "join",
  "review",
  "--agent",
  "@+alder-turner",
  "--scope",
  "Tooling review",
);
const id = cli(
  "send",
  "--from",
  "alder-turner",
  "--to",
  "@josh",
  "--to",
  "@+birch-weaver",
  "--subject",
  "Markdown conversation",
  "--body",
  '# Fixture heading\n\n**Bold text** and a searchable persimmon.\n\n```mermaid\ngraph LR\n Mail --> Reply\n```\n\n![remote](https://example.invalid/tracker.png)\n\n<script>parent.document.body.dataset.compromised="yes"</script>\n\n[unsafe](javascript:alert(1))',
);
const processServer = spawn(
  join(root, "bin/agent-mail-web"),
  ["--port", "0", "--no-open"],
  {
    env,
    stdio: ["ignore", "pipe", "inherit"],
  },
);
let browser;
try {
  const lines = createInterface({ input: processServer.stdout });
  const url = await Promise.race([
    new Promise((resolve, reject) => {
      lines.on("line", (line) => {
        if (line.startsWith("http://")) resolve(line);
      });
      processServer.once("exit", () =>
        reject(new Error("Bridge exited before startup")),
      );
    }),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("Bridge startup timed out")),
        10000,
      ).unref(),
    ),
  ]);
  // Headless Chrome otherwise hides the scrollbars that drive resize feedback.
  browser = await chromium.launch(
    process.env.CHROME_EXECUTABLE
      ? {
          executablePath: process.env.CHROME_EXECUTABLE,
          headless: true,
          ignoreDefaultArgs: ["--hide-scrollbars"],
        }
      : {
          channel: "chrome",
          headless: true,
          ignoreDefaultArgs: ["--hide-scrollbars"],
        },
  );
  const page = await browser.newPage({
    viewport: { width: 1200, height: 850 },
    colorScheme: "light",
  });
  const errors = [],
    remote = [],
    dialogs = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (r.url().startsWith("https://")) remote.push(r.url());
  });
  let cancelNextDialog = false;
  page.on("dialog", (d) => {
    dialogs.push(d.type() + ": " + d.message());
    if (cancelNextDialog) {
      cancelNextDialog = false;
      return d.dismiss();
    }
    return d.accept();
  });
  await page.goto(url);
  await page.waitForSelector(".row");
  await page.locator("#realm").waitFor({ state: "visible" });
  assert.equal(await page.locator("#realm").textContent(), "Testrealm");
  const dates = await page.evaluate((now) => ({
    recent: date(now - 2 * 60 * 60 * 1000),
    old: date(now - 4 * 24 * 60 * 60 * 1000),
    future: date(now + 2 * 60 * 1000),
    missing: date(null),
  }), Date.now());
  assert.match(dates.recent, /^2 hours ago$/);
  assert.doesNotMatch(dates.old, /\b(?:ago|in)\b/);
  assert.match(dates.future, /^in 2 minutes$/);
  assert.equal(dates.missing, "");
  const listedTime = page.locator(".row time").first();
  assert.match(await listedTime.textContent(), /ago$/);
  assert.match(await listedTime.getAttribute("datetime"), /^\d{4}-\d{2}-\d{2}T/);
  assert(await listedTime.getAttribute("title"));
  await page.route("**/reader.css", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body:
        (await response.text()) +
        "\n::-webkit-scrollbar { width: 15px; height: 15px; }",
    });
  });
  await page.evaluate(async () => {
    const target = document.createElement("section");
    target.id = "resize-fixture";
    document.body.append(target);
    window.readerResizeHeights = [];
    window.recordReaderHeight = (event) => {
      if (
        event.source === target.querySelector("iframe")?.contentWindow &&
        event.data?.type === "height"
      )
        window.readerResizeHeights.push(event.data.height);
    };
    window.addEventListener("message", window.recordReaderHeight);
    await renderMarkdown(
      Array.from({ length: 17 }, (_, i) =>
        "A message should keep its size after the browser finishes wrapping these words. ".repeat(
          2 + (i % 5),
        ),
      ).join("\n\n"),
      target,
    );
  });
  const resizingReader = page.frameLocator("#resize-fixture iframe");
  await resizingReader.locator("p").last().waitFor();
  for (const [zoom, width] of [
    [0.8, 469],
    [0.9, 423],
    [1, 620],
    [1.25, 469],
  ]) {
    await page.evaluate(
      ({ zoom, width }) => {
        window.readerResizeHeights = [];
        document.body.style.zoom = zoom;
        const frame = document.querySelector("#resize-fixture iframe");
        frame.style.width = width + "px";
        frame.scrollIntoView();
      },
      { zoom, width },
    );
    await page.waitForTimeout(250);
    const settledCount = await page.evaluate(
      () => window.readerResizeHeights.length,
    );
    assert.ok(
      settledCount > 0,
      "Reader should resize after changing its width",
    );
    await page.waitForTimeout(350);
    const heights = await page.evaluate(() => window.readerResizeHeights);
    assert.equal(
      heights.length,
      settledCount,
      `Reader resize loop at zoom ${zoom}, width ${width}: ${heights.slice(-8)}`,
    );
    const gutter = await resizingReader
      .locator("body")
      .evaluate(() => window.innerWidth - document.documentElement.clientWidth);
    assert.ok(gutter < 2, `Unexpected reader scrollbar: ${gutter}px`);
  }
  await page.evaluate(() => {
    document.body.style.zoom = "";
    document.getElementById("resize-fixture").remove();
    window.removeEventListener("message", window.recordReaderHeight);
    delete window.recordReaderHeight;
    delete window.readerResizeHeights;
  });
  await page.unroute("**/reader.css");
  assert.equal(
    await page.locator('link[rel="icon"]').getAttribute("href"),
    "/favicon.svg",
  );
  const favicon = await page.request.get(new URL("/favicon.svg", url).href);
  assert.equal(favicon.status(), 200);
  assert.equal(favicon.headers()["content-type"], "image/svg+xml");
  const icons = await page.evaluate(() =>
    Object.fromEntries(
      [
        "josh",
        "@josh",
        "humans/josh",
        "josh@example.invalid",
        "@+josh",
        "alder-turner",
        "@+alder-turner",
        "alder-turner-12345678",
        "birch-weaver",
        '<svg onload="alert(1)">',
      ].map((address) => [address, avatarImage(address).getAttribute("src")]),
    ),
  );
  assert.equal(icons.josh, "/josh-avatar.png");
  // Team badges: current memberships only, at most two badges then "+N".
  const alderBadges = page.locator('.sender .avatar-wrap[data-key="agent:alder-turner"] .team-badge');
  await alderBadges.first().waitFor();
  const badged = await page.evaluate(() => {
    const wrap = document.querySelector('.avatar-wrap[data-key="agent:alder-turner"]');
    const make = (n) => Array.from({ length: n }, (_, i) => ({ handle: "@team/t" + i, name: "Team " + i }));
    teamsByMember.set("agent:fixture-busy", make(4));
    const busy = avatar("@+fixture-busy");
    return {
      badges: [...wrap.querySelectorAll(".team-badge")].map((b) => b.textContent),
      title: wrap.title,
      label: wrap.querySelector(".team-badges").getAttribute("aria-label"),
      josh: document.querySelector("#current-user .avatar-wrap .team-badge"),
      busy: [...busy.querySelectorAll(".team-badge")].map((b) => b.textContent),
    };
  });
  assert.deepEqual(badged.badges.sort(), ["O", "R"]);
  assert.match(badged.title, /@team\/orchard/);
  assert.match(badged.title, /@team\/review/);
  assert.equal(badged.label, badged.title);
  assert.equal(badged.josh, null);
  assert.deepEqual(badged.busy, ["T", "+3"]);
  const personalIcon = await page.request.get(new URL(icons.josh, url).href);
  assert.equal(personalIcon.status(), 200);
  assert.equal(personalIcon.headers()["content-type"], "image/png");
  assert.deepEqual(
    await personalIcon.body(),
    await readFile(join(root, "apps/agent-mail-web/josh-avatar.png")),
  );
  assert.equal(icons.josh, icons["@josh"]);
  assert.equal(icons.josh, icons["humans/josh"]);
  assert.equal(icons.josh, icons["josh@example.invalid"]);
  assert.notEqual(icons.josh, icons["@+josh"]);
  assert.equal(icons["alder-turner"], icons["@+alder-turner"]);
  assert.equal(icons["alder-turner"], icons["alder-turner-12345678"]);
  assert.notEqual(icons["alder-turner"], icons["birch-weaver"]);
  assert(
    !decodeURIComponent(icons['<svg onload="alert(1)">']).includes("onload"),
  );
  assert.equal(
    await page.locator("#current-user .avatar").getAttribute("src"),
    icons.josh,
  );
  await page
    .getByRole("button", { name: /alder-turner Markdown conversation/ })
    .waitFor();
  assert.equal(
    await page.locator(".sender .avatar").first().getAttribute("src"),
    icons["alder-turner"],
  );
  await page.waitForFunction(() =>
    [...document.querySelectorAll("img.avatar")].every(
      (image) => image.complete && image.naturalWidth > 0,
    ),
  );
  // Session inspection must be on demand, not ahead of reader assets.
  let inspectionCalls = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/contact") inspectionCalls++;
  });
  await page
    .getByRole("button", { name: /alder-turner Markdown conversation/ })
    .click();
  await page.frameLocator("#thread iframe").getByRole("heading", { name: "Fixture heading" }).waitFor();
  assert.equal(inspectionCalls, 0);
  const sidebar = page.getByRole("complementary", {
    name: "Thread participants",
  });
  for (const summary of await sidebar.locator(".contact > summary").all())
    await summary.click();
  assert.equal(
    await page.locator("#thread summary .avatar").first().getAttribute("src"),
    icons["alder-turner"],
  );
  await sidebar
    .getByText("Investigate orchard migrations", { exact: true })
    .waitFor();
  await sidebar
    .getByText("Your human inbox; not an agent session.", { exact: true })
    .waitFor();
  await sidebar
    .getByText(
      "Historical contact; no registered session transcript is available.",
      { exact: true },
    )
    .waitFor();
  assert.equal(await sidebar.locator(".contact").count(), 3);
  await sidebar
    .locator(".contact")
    .filter({ hasText: "@+alder-turner" })
    .getByRole("button", { name: "View transcript", exact: true })
    .waitFor();
  assert.equal(
    await sidebar
      .locator(".contact")
      .filter({ hasText: "@josh" })
      .getByRole("button", { name: "View transcript", exact: true })
      .count(),
    0,
  );
  await sidebar
    .getByText("fixture-provider/cedar-v2", { exact: true })
    .first()
    .waitFor();
  await sidebar.getByText("Models observed (2)", { exact: true }).click();
  await sidebar.getByText("fixture-provider/oak-v1", { exact: true }).waitFor();
  if (process.env.AGENT_MAIL_TEST_SCREENSHOT)
    await sidebar.screenshot({
      path: process.env.AGENT_MAIL_TEST_SCREENSHOT + "-models.png",
    });
  await sidebar.getByText("Models observed (2)", { exact: true }).click();
  async function assertTeams(container) {
    const memberships = container.getByRole("region", {
      name: "Team memberships",
      exact: true,
    });
    await memberships.locator("details").nth(1).waitFor();
    assert.equal(await memberships.locator("details").count(), 2);
    const orchard = memberships
      .locator("details")
      .filter({ hasText: "@team/orchard" });
    const review = memberships
      .locator("details")
      .filter({ hasText: "@team/review" });
    assert.match(
      await orchard.locator("summary").textContent(),
      /Orchard crew · coordinator/,
    );
    assert.match(
      await review.locator("summary").textContent(),
      /Review group · member/,
    );
    await orchard.locator("summary").click();
    await orchard.getByText("@+alder-turner", { exact: true }).waitFor();
    await orchard.getByText("Joined", { exact: true }).waitFor();
    await orchard
      .getByText(join(env.AGENT_TEAM_ROOT, "orchard/scratchpad"), {
        exact: true,
      })
      .waitFor();
    await review.locator("summary").click();
    await review.getByText("@+birch-weaver", { exact: true }).waitFor();
    await review.getByText("Tooling review", { exact: true }).waitFor();
    if (process.env.AGENT_MAIL_TEST_SCREENSHOT)
      await memberships.screenshot({
        path:
          process.env.AGENT_MAIL_TEST_SCREENSHOT +
          (container === sidebar ? "-sidebar-teams.png" : "-contact-teams.png"),
      });
    await orchard.locator("summary").click();
    await review.locator("summary").click();
  }
  await assertTeams(sidebar);
  const teamStates = await page.evaluate(() => {
    const base = { resume: "fixture", modelsUsed: [] };
    const empty = sessionDetails({ ...base, teams: [] });
    const unavailable = sessionDetails({
      ...base,
      teams: null,
      teamsWarning: "Fixture registry unavailable",
    });
    const missing = sessionDetails(base);
    const hostile = sessionDetails({
      ...base,
      teams: [
        {
          handle: "@team/example",
          name: '<img src=x onerror="alert(1)">',
          role: "member",
          coordinator: "@+fixture-agent",
          scope: "<script>bad()</script>",
          scratchpad: "/fixture",
          joinedAt: null,
        },
      ],
    });
    return {
      empty: empty.textContent,
      unavailable: unavailable.textContent,
      missing: missing.textContent,
      hostile: hostile.textContent,
      unsafeElements: hostile.querySelectorAll("img,script").length,
    };
  });
  assert(teamStates.empty.includes("No active teams."));
  assert(teamStates.unavailable.includes("Team membership unavailable."));
  assert(teamStates.unavailable.includes("Fixture registry unavailable"));
  assert(!teamStates.unavailable.includes("No active teams."));
  assert(teamStates.missing.includes("Team membership unavailable."));
  assert(teamStates.hostile.includes("<script>bad()</script>"));
  assert.equal(teamStates.unsafeElements, 0);
  await sidebar
    .getByRole("button", { name: "Copy resume command", exact: true })
    .waitFor();
  await sidebar.getByText("More session details", { exact: true }).click();
  await sidebar.getByText(sid, { exact: true }).waitFor();
  await sidebar.getByText("More session details", { exact: true }).click();
  assert(
    await page.evaluate(
      () =>
        document.getElementById("thread-contacts").getBoundingClientRect()
          .left >=
        document.getElementById("thread").getBoundingClientRect().right,
    ),
  );
  await page.evaluate(() =>
    renderParticipantCards([
      {
        from: "alder-turner-12345678",
        to: "@+alder-turner, josh, @josh, birch-weaver",
      },
    ]),
  );
  assert.equal(await sidebar.locator(".contact").count(), 3);
  const reader = page.frameLocator("#thread iframe").last();
  await reader.getByRole("heading", { name: "Fixture heading" }).waitFor();
  await reader.getByText("Mail", { exact: true }).waitFor();
  await reader.getByText("Reply", { exact: true }).waitFor();
  await assertReaderFits(reader);
  await page.setViewportSize({ width: 375, height: 850 });
  await assertReaderFits(reader);
  assert(
    await page.evaluate(
      () =>
        document.getElementById("thread-contacts").getBoundingClientRect()
          .top >=
        document.getElementById("thread").getBoundingClientRect().bottom,
    ),
  );
  await page.setViewportSize({ width: 1200, height: 850 });
  await assertReaderFits(reader);
  assert.equal(
    await page.evaluate(() => document.body.dataset.compromised),
    undefined,
  );
  assert.equal((await readdir(join(humans, "josh/inbox/new"))).length, 1);
  assert.deepEqual(remote, []);
  await page.locator("#reply-all").click();
  await page.locator("#editor").waitFor({ state: "visible" });
  assert.equal(await page.locator("#reader").isVisible(), true);
  await page.getByRole("complementary", { name: "Message recipients" }).getByText("Investigate orchard migrations", { exact: true }).waitFor();
  assert.equal(await page.locator("#recipient-cards > .contact").count(), 2);
  const panels = await page.evaluate(() => ({
    reader: document.getElementById("reader").getBoundingClientRect().toJSON(),
    editor: document.getElementById("editor").getBoundingClientRect().toJSON(),
  }));
  assert(panels.editor.left >= panels.reader.right);
  const context = page.frameLocator("#thread iframe").last();
  await context.getByRole("heading", { name: "Fixture heading" }).waitFor();
  const quote = await context
    .locator("p")
    .first()
    .evaluate((paragraph) => {
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return selection.toString();
    });
  assert(quote.includes("searchable persimmon"));
  await context.locator("body").press("e");
  assert.equal((await readdir(join(humans, "josh/inbox/new"))).length, 1);
  await page.setViewportSize({ width: 375, height: 850 });
  assert(
    await page.evaluate(
      () =>
        document.getElementById("editor").getBoundingClientRect().top >=
        document.getElementById("reader").getBoundingClientRect().bottom,
    ),
  );
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.setViewportSize({ width: 1200, height: 850 });
  assert.equal(
    await page.locator("#to").inputValue(),
    "alder-turner, birch-weaver",
  );
  await page
    .locator("#body")
    .fill(
      "Reply with **Markdown**.\n\n> " +
        quote +
        "\n\n" +
        "A paragraph-only message should grow with its content.\n\n".repeat(12),
    );
  await page.locator("#image").setInputFiles({
    name: "pixel.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7ZkAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  await page.waitForFunction(() =>
    document.getElementById("body").textContent.includes("file:"),
  );
  // An image the bridge would reject is rasterized client-side: SVG is not one of
  // PNG/JPEG/GIF/WebP, so the upload must come back as a JPEG.
  await page.locator("#image").setInputFiles({
    name: "vector.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#002FA7"/></svg>',
    ),
  });
  await page.waitForFunction(() =>
    document.getElementById("body").textContent.includes("vector.svg"),
  );
  assert.match(
    await page.locator("#body").textContent(),
    /!\[vector\.svg\]\(file:[^)]+\.jpg\)/,
  );
  await page.locator("#preview-button").click();
  await page
    .frameLocator("#preview iframe")
    .getByRole("img", { name: "pixel.png" })
    .waitFor();
  await assertReaderFits(page.frameLocator("#preview iframe"));
  // Settle the scroll after preview sizing before aiming the send click.
  await page.locator("#send").scrollIntoViewIfNeeded();
  const dialogsBeforeClickSend = dialogs.length;
  await page.locator("#send").click();
  await page
    .getByText("Sent. A copy is retained in Sent.")
    .waitFor()
    .catch(async (error) => {
      console.error(
        "Send state:",
        await page.locator("#status").textContent(),
        await page.locator("#draft-status").textContent(),
        {
          editor: await page.locator("#editor").isVisible(),
          reader: await page.locator("#reader").isVisible(),
          sendDisabled: await page.locator("#send").isDisabled(),
          sent: await readdir(join(humans, "josh/sent")),
          dialogs,
        },
      );
      throw error;
    });
  assert.equal(
    dialogs.length,
    dialogsBeforeClickSend,
    "Send should not open a dialog",
  );
  const sent = await readdir(join(humans, "josh/sent"));
  assert.equal(sent.length, 1);
  const copy = await readFile(join(humans, "josh/sent", sent[0]), "utf8");
  assert(copy.includes("Thread-ID: " + id));
  assert(copy.includes("Reply with **Markdown**."));
  await page.locator("#reader").waitFor({ state: "visible" });
  assert.equal(
    await page.locator("#thread summary .avatar").last().getAttribute("src"),
    icons.josh,
  );
  assert.equal(await page.locator("#mail-list").isVisible(), false);
  await page
    .frameLocator("#thread iframe")
    .last()
    .getByText("Reply with Markdown.", { exact: true })
    .waitFor();
  assert.equal(await page.locator("#archive").isEnabled(), true);
  await page.waitForFunction(
    () => document.querySelectorAll("#thread details.message").length === 2,
  );
  assert.equal(await page.locator("#thread details.message").count(), 2);
  await page.locator("#archive").click();
  await page.getByText("Conversation archived.", { exact: true }).waitFor();
  assert.equal((await readdir(join(humans, "josh/inbox/new"))).length, 0);
  await page.locator("#search").fill("persimmon");
  await page.locator("#search").press("Enter");
  await page.locator(".row").waitFor();
  assert.equal(await page.locator(".row").count(), 1);
  await page.locator(".row").click();
  await page.locator("#reply").click();
  await page.locator("#body").fill("Reply resumed from a saved draft.");
  await page.locator("#close-draft").click();
  await page.reload();
  await page.getByRole("button", { name: /^Drafts/ }).click();
  await page.locator(".row").click();
  await page.locator("#editor").waitFor({ state: "visible" });
  assert.equal(await page.locator("#reader").isVisible(), true);
  await page
    .frameLocator("#thread iframe")
    .last()
    .getByText("Reply with Markdown.", { exact: true })
    .waitFor();
  const dialogsBeforeReplySend = dialogs.length;
  await page.locator("#body").press("Meta+Enter");
  await page.locator("#reader").waitFor({ state: "visible" });
  await page.waitForFunction(
    () => document.querySelectorAll("#thread details.message").length === 3,
  );
  await page
    .frameLocator("#thread iframe")
    .last()
    .getByText("Reply resumed from a saved draft.", { exact: true })
    .waitFor();
  assert.equal(
    dialogs.length,
    dialogsBeforeReplySend,
    "Reply shortcut should not open a dialog",
  );
  assert.equal(await page.locator("#archive").isDisabled(), true);
  await page.keyboard.press("g");
  await page.keyboard.press("c");
  const directory = page.locator("#contact-list");
  await directory
    .locator(".contact summary")
    .filter({ hasText: "@+alder-turner" })
    .click();
  assert.equal(
    await directory
      .locator(".contact summary")
      .filter({ hasText: "@+alder-turner" })
      .locator(".avatar")
      .getAttribute("src"),
    icons["alder-turner"],
  );
  await directory
    .getByText("Investigate orchard migrations", { exact: true })
    .waitFor();
  assert.equal(await directory.locator(".avatar").first().evaluate((image) => image.getBoundingClientRect().width), 48);
  assert(await page.locator("#current-user .avatar").evaluate((image) => image.getBoundingClientRect().width < 28));
  await directory.getByText("/fixture/orchard", { exact: true }).waitFor();
  await assertTeams(directory);
  await directory.getByText("Latest recorded model", { exact: true }).waitFor();
  await directory
    .getByText("fixture-provider/cedar-v2", { exact: true })
    .first()
    .waitFor();
  await directory.getByText("Models observed (2)", { exact: true }).click();
  await directory
    .getByText("fixture-provider/oak-v1", { exact: true })
    .waitFor();
  await directory
    .getByText(/First: .*Last:/)
    .first()
    .waitFor();
  await directory
    .getByRole("button", { name: "Copy resume command", exact: true })
    .waitFor();
  const transcriptErrors = [];
  const transcriptPromise = page.waitForEvent("popup");
  await directory
    .getByRole("button", { name: "View transcript", exact: true })
    .click();
  const transcript = await transcriptPromise;
  transcript.on("pageerror", (error) => transcriptErrors.push(error.message));
  await transcript.getByText("orchard incident analysis <script>unsafe()</script>", { exact: true }).waitFor();
  assert.equal(await transcript.locator("script").count(), 1, "Transcript text must not become markup");
  const assistantEntry = transcript.locator("details.entry.role-assistant").filter({ hasText: "I will inspect it." });
  await assistantEntry.getByText("Tool call · read", { exact: true }).click();
  assert.equal(await assistantEntry.locator("details").first().evaluate((node) => node.open), true);
  await assistantEntry.locator(":scope > summary").click();
  assert.equal(await assistantEntry.evaluate((node) => node.open), false);
  await appendFile(
    sessionFile,
    JSON.stringify({
      type: "message",
      id: "fixture-live",
      parentId: "fixture-assistant",
      timestamp: new Date().toISOString(),
      message: { role: "assistant", content: "Live transcript update.", timestamp: Date.now() },
    }) + "\n",
  );
  await transcript.getByText("Live transcript update.", { exact: true }).waitFor({ timeout: 5000 });
  const liveEntry = transcript.locator("details.entry").filter({ hasText: "Live transcript update." });
  assert.match(await liveEntry.locator(":scope > summary time").textContent(), /ago$/);
  assert(await liveEntry.locator(":scope > summary time").getAttribute("title"));
  assert.equal(await assistantEntry.evaluate((node) => node.open), false);
  assert.equal(await assistantEntry.locator("details").first().evaluate((node) => node.open), true);
  assert.match(await transcript.getByRole("complementary").textContent(), /recorded branches/);
  const missingSession = sessionFile + ".missing";
  await rename(sessionFile, missingSession);
  await transcript.getByText("No retained Pi transcript is registered for this contact.", { exact: true }).waitFor({ timeout: 5000 });
  assert.equal(await transcript.locator("#entries").getByText("Live transcript update.", { exact: true }).count(), 0);
  await rename(missingSession, sessionFile);
  await transcript.getByText("Live transcript update.", { exact: true }).waitFor({ timeout: 5000 });
  assert.deepEqual(transcriptErrors, []);
  await transcript.close();
  await directory
    .getByRole("button", { name: "Show mail", exact: true })
    .click();
  await page.locator("#mail-list").waitFor({ state: "visible" });
  assert.equal(
    await page.locator("#search").inputValue(),
    "with:@+alder-turner",
  );
  assert.equal(
    await page.locator('[data-folder="all"]').getAttribute("aria-current"),
    "page",
  );
  await page.locator(".row").filter({ hasText: "(3)" }).waitFor();
  await page.locator(".row").click();
  await page.locator("#reply").click();
  await page.locator("#body").fill("Contact navigation preserves this draft.");
  await sidebar.locator(".contact").filter({ hasText: "@+alder-turner" }).locator("summary").first().click();
  await sidebar
    .locator(".contact")
    .filter({ hasText: "@+alder-turner" })
    .getByRole("button", { name: "Show mail", exact: true })
    .click();
  await page.locator("#mail-list").waitFor({ state: "visible" });
  assert.equal(
    await page.locator("#search").inputValue(),
    "with:@+alder-turner",
  );
  const navigationDrafts = await readdir(join(humans, "josh/drafts"));
  assert.equal(navigationDrafts.length, 1);
  assert(
    (
      await readFile(join(humans, "josh/drafts", navigationDrafts[0]), "utf8")
    ).includes("Contact navigation preserves this draft."),
  );
  await page.getByRole("button", { name: /^Drafts/ }).click();
  await page.getByRole("heading", { name: "Drafts", exact: true }).waitFor();
  await page.locator(".row").click();
  await page.locator("#delete-draft").click();
  await page.getByText("Draft deleted.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Contacts", exact: true }).click();
  await page.locator("#contact-search").fill("orchard");
  await page.locator("#contact-search").press("Enter");
  await page.getByText(/1 matching sessions/).waitFor();
  assert.equal(await directory.locator(".contact").count(), 1);
  await directory.getByText(sid, { exact: true }).waitFor();
  await page.locator("#contact-search").fill("no-such-fixture-topic");
  await page.locator("#contact-search").press("Enter");
  await page.getByText(/0 matching sessions/).waitFor();
  assert.equal(await directory.locator(".contact").count(), 0);
  await page.locator("#all-contacts").click();
  await directory
    .locator(".contact summary")
    .filter({ hasText: "@+alder-turner" })
    .waitFor();
  await page.locator("#compose").click();
  const recipients = page.getByRole("complementary", { name: "Message recipients" });
  await recipients.getByText("Select recipients to see their contact details.", { exact: true }).waitFor();
  await page.locator("#to").fill("@+alder-turner, @josh");
  await page.locator("#subject").fill("Saved draft");
  await page.locator("#body").fill("First version");
  await recipients.getByText("Investigate orchard migrations", { exact: true }).waitFor();
  await recipients.getByText("fixture-provider/cedar-v2", { exact: true }).first().waitFor();
  await recipients.getByText("Your human inbox; not an agent session.", { exact: true }).waitFor();
  assert.equal(await recipients.locator(".contact").count(), 2);
  assert(await page.evaluate(() => $("compose-contacts").getBoundingClientRect().left >= $("compose-fields").getBoundingClientRect().right));
  if (process.env.AGENT_MAIL_TEST_SCREENSHOT) await page.screenshot({ path: process.env.AGENT_MAIL_TEST_SCREENSHOT + "-compose-recipients-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => $("compose-contacts").getBoundingClientRect().top >= $("compose-fields").getBoundingClientRect().bottom && document.documentElement.scrollWidth <= innerWidth));
  if (process.env.AGENT_MAIL_TEST_SCREENSHOT) await page.screenshot({ path: process.env.AGENT_MAIL_TEST_SCREENSHOT + "-compose-recipients-mobile.png", fullPage: true });
  await page.setViewportSize({ width: 1200, height: 850 });
  await page.locator("#to").fill("@+alder-turner, @+alder-turner");
  assert.equal(await recipients.locator(".contact").count(), 1);
  const inspections = [];
  page.on("request", (request) => { const url = new URL(request.url()); if (url.pathname === "/api/contact") inspections.push(url.searchParams.get("handle")); });
  await page.locator("#to").fill("@+alder-turner-12345678");
  await page.locator("#subject").focus();
  await recipients.getByText("Historical contact; no registered session transcript is available.", { exact: true }).waitFor();
  assert(inspections.includes("@+alder-turner-12345678"));
  assert(!inspections.includes("@+alder-turner"));
  assert.equal(await page.evaluate(() => composer.value()), "First version");
  await page.locator("#to").fill("@+alder-turner");
  await page.route("**/api/save", async (route) => {
    const response = await route.fetch();
    await new Promise((r) => setTimeout(r, 300));
    await route.fulfill({ response });
  });
  await page.locator("#save-draft").click();
  await page.locator("#body").fill("Latest version while save was in flight");
  await page.locator("#close-draft").click();
  await page.getByRole("button", { name: /josh Saved draft/ }).waitFor();
  await page.reload();
  await page.getByRole("button", { name: /^Drafts/ }).click();
  await page.getByRole("button", { name: /josh Saved draft/ }).click();
  await page.locator("#editor").waitFor({ state: "visible" });
  assert.equal(
    await page.locator("#body").textContent(),
    "Latest version while save was in flight",
  );
  await recipients.getByText("Investigate orchard migrations", { exact: true }).waitFor();
  assert.equal(await recipients.locator(".contact").count(), 1);
  // Typing Gmail shortcut letters in the composer must not navigate or archive.
  await page.locator("#body").press("e");
  for (const key of ["g", "c", "g", "t"]) await page.locator("#body").press(key);
  assert.equal(await page.locator("#editor").isVisible(), true);
  const beforeSend = await page.evaluate(() => composer.value());
  const dialogsBeforeShortcutSend = dialogs.length;
  const countBeforeShortcutSend = (
    await readdir(join(humans, "josh/sent"))
  ).length;
  await page.locator("#body").press("Control+Enter");
  await page.keyboard.press("Control+Enter");
  await page.getByRole("heading", { name: "Sent", exact: true }).waitFor();
  assert.equal(
    dialogs.length,
    dialogsBeforeShortcutSend,
    "Send shortcut should not open a dialog",
  );
  assert.equal(
    (await readdir(join(humans, "josh/sent"))).length,
    countBeforeShortcutSend + 1,
  );
  assert.equal(await page.locator("#reader").isVisible(), false);
  assert.equal(await page.evaluate(() => composer.value()), beforeSend);
  const sentBeforeDelete = await readdir(join(humans, "josh/sent"));
  await page.locator("#compose").click();
  await page.locator("#body").fill("Disposable draft");
  cancelNextDialog = true;
  await page.locator("#delete-draft").click();
  assert.equal(await page.locator("#editor").isVisible(), true);
  assert.equal((await readdir(join(humans, "josh/drafts"))).length, 1);
  await page.locator("#save-draft").click();
  await page.locator("#body").fill("Unsaved changes while a save is in flight");
  await page.locator("#delete-draft").click();
  await page.getByText("Draft deleted.", { exact: true }).waitFor();
  await page.getByRole("heading", { name: "Drafts", exact: true }).waitFor();
  assert.equal((await readdir(join(humans, "josh/drafts"))).length, 0);
  assert.deepEqual(await readdir(join(humans, "josh/sent")), sentBeforeDelete);
  assert.equal((await readdir(join(humans, "josh/inbox/cur"))).length, 1);
  await page.reload();
  await page.getByRole("button", { name: /^Drafts/ }).click();
  await page.getByText("No messages here.", { exact: true }).waitFor();
  assert.equal(
    await page.locator("#current-user .avatar").getAttribute("src"),
    icons.josh,
  );
  await page.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "g" }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "i" }));
  });
  await page.getByRole("heading", { name: "Inbox", exact: true }).waitFor();
  await page.locator("#compose").click();
  await page.getByText(/3 local keywords/).waitFor();
  const body = page.locator("#body");
  await body.fill("@+ald");
  await body.press("Control+n");
  await page.locator(".cm-tooltip-autocomplete").waitFor();
  // CodeMirror guards against accidental acceptance for the first 75 ms.
  await page.waitForTimeout(100);
  await body.press("Tab");
  assert.match(await body.textContent(), /^@\+alder-(turner|weaver)$/);
  await body.fill("name.w");
  await body.press("Control+p");
  await page.locator(".cm-tooltip-autocomplete").waitFor();
  await page.waitForTimeout(100);
  await body.press("Tab");
  assert.equal(await body.textContent(), "name.with_dot");
  await body.fill("one\ntwo\nthree");
  await page.locator("#vim-mode").check();
  await body.press("g");
  await body.press("g");
  await body.press("d");
  await body.press("d");
  assert.equal(await page.evaluate(() => composer.value()), "two\nthree");
  await body.press("u");
  assert.equal(await page.evaluate(() => composer.value()), "one\ntwo\nthree");
  await body.press("Control+r");
  assert.equal(await page.evaluate(() => composer.value()), "two\nthree");
  assert.equal(await page.locator("#editor").isVisible(), true);
  await page.locator("#vimrc-button").click();
  await page
    .locator("#vimrc-input")
    .fill(
      'inoremap jk <Esc>\nset number\nlet mapleader=","\nnnoremap <leader>x dd',
    );
  await page.locator("#vimrc-input").press("Control+Enter");
  assert.equal(await page.locator("#vimrc-dialog").isVisible(), true);
  await page.locator("#vimrc-apply").click();
  await page
    .getByText("2 mappings applied; unsupported lines ignored: 2")
    .waitFor();
  await page
    .locator("#vimrc-dialog")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await body.press("i");
  await page.keyboard.type("jk");
  await page.keyboard.type(",x");
  assert.equal(await page.evaluate(() => composer.value()), "three");
  await body.press("u");
  await page.locator("#vimrc-button").click();
  await page
    .locator("#vimrc-input")
    .fill(
      'inoremap jk <Esc>\nlet mapleader="\\<Space>"\nnnoremap <leader>x dd',
    );
  await page.locator("#vimrc-apply").click();
  await page.getByText("2 mappings applied.", { exact: true }).waitFor();
  await page.locator("#vimrc-input").fill("inoremap jk");
  await page.locator("#vimrc-apply").click();
  await page.getByText(/a mapping needs a key and an action/).waitFor();
  await page
    .locator("#vimrc-dialog")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await body.press("Space");
  await body.press("x");
  assert.equal(await page.evaluate(() => composer.value()), "three");
  if (process.env.AGENT_MAIL_TEST_SCREENSHOT) {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.screenshot({
      path: process.env.AGENT_MAIL_TEST_SCREENSHOT + "-vim.png",
      fullPage: true,
    });
    await page.emulateMedia({ colorScheme: "light" });
  }
  await body.press("i");
  await page.keyboard.type("@+ald");
  await body.press("Control+n");
  await page.locator(".cm-tooltip-autocomplete").waitFor();
  // CodeMirror guards against accidental acceptance for the first 75 ms.
  await page.waitForTimeout(100);
  await body.press("Tab");
  assert.match(
    await page.evaluate(() => composer.value()),
    /^@\+alder-(turner|weaver)three$/,
  );
  await body.press("Escape");
  await page.locator("#close-draft").click();
  await page.reload();
  await page.getByRole("button", { name: /^Drafts/ }).click();
  await page.locator(".row").click();
  assert.equal(await page.locator("#vim-mode").isChecked(), true);
  await page.locator("#vimrc-button").click();
  assert.match(await page.locator("#vimrc-input").inputValue(), /inoremap jk/);
  await page
    .locator("#vimrc-dialog")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await page.locator("#vim-mode").uncheck();
  await writeFile(keywordFile, "@+new-fixture-agent\n");
  await page.locator("#close-draft").click();
  await page.locator(".row").click();
  await page.getByText(/1 local keyword/).waitFor();
  await body.fill("@+new");
  await body.press("Control+n");
  await page.locator(".cm-tooltip-autocomplete").waitFor();
  // CodeMirror guards against accidental acceptance for the first 75 ms.
  await page.waitForTimeout(100);
  if (process.env.AGENT_MAIL_TEST_SCREENSHOT)
    await page.screenshot({
      path: process.env.AGENT_MAIL_TEST_SCREENSHOT + "-light.png",
      fullPage: true,
    });
  await body.press("Tab");
  assert.equal(await body.textContent(), "@+new-fixture-agent");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 390, height: 844 });
  if (process.env.AGENT_MAIL_TEST_SCREENSHOT)
    await page.screenshot({
      path: process.env.AGENT_MAIL_TEST_SCREENSHOT + "-dark.png",
      fullPage: true,
    });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await rm(keywordFile);
  await page.locator("#close-draft").click();
  await page.locator(".row").click();
  await page.getByText(/No local keywords.txt found/).waitFor();
  assert.equal(await page.locator("#body").isEditable(), true);

  team("transfer", "review", "--coordinator", "@+alder-turner", "--accept");
  team("leave", "review", "--agent", "@+birch-weaver");
  team("archive", "review");
  await body.fill("Teams navigation preserves this draft.");
  await page.locator("#teams-button").focus();
  await page.keyboard.press("g");
  await page.keyboard.press("t");
  const teamsPage = page.getByRole("region", { name: "Teams", exact: true });
  await teamsPage
    .getByText("2 teams · 1 active · 1 archived", { exact: true })
    .waitFor();
  assert.equal(
    await page.locator("#teams-button").getAttribute("aria-current"),
    "page",
  );
  assert.equal(
    await page.locator('[data-folder][aria-current="page"]').count(),
    0,
  );
  assert.equal(await page.locator("#editor").isVisible(), false);
  const savedTeamNavigation = await readdir(join(humans, "josh/drafts"));
  assert(
    (
      await readFile(
        join(humans, "josh/drafts", savedTeamNavigation[0]),
        "utf8",
      )
    ).includes("Teams navigation preserves this draft."),
  );
  const orchardCard = teamsPage.locator(".team-card").filter({
    has: page.locator("summary").filter({ hasText: "@team/orchard ·" }),
  });
  const retiredCard = teamsPage.locator(".team-card").filter({
    has: page.locator("summary").filter({ hasText: "@team/review ·" }),
  });
  await retiredCard.locator(":scope > summary").click();
  assert.equal(
    await retiredCard
      .getByRole("button", { name: "Message team", exact: true })
      .isDisabled(),
    true,
  );
  await retiredCard.getByText("Retained roster", { exact: true }).waitFor();
  await retiredCard.getByText("Team history", { exact: true }).click();
  await retiredCard
    .getByText(/Coordinator: @\+birch-weaver → @\+alder-turner/)
    .waitFor();
  await retiredCard.getByText(/@\+birch-weaver · .*Left:/).waitFor();
  await retiredCard.locator(":scope > summary").click();
  await orchardCard.locator(":scope > summary").click();
  await orchardCard
    .getByText(join(env.AGENT_TEAM_ROOT, "orchard/scratchpad"), { exact: true })
    .waitFor();
  await orchardCard.locator(".contact > summary").click();
  await orchardCard
    .getByText("Investigate orchard migrations", { exact: true })
    .waitFor();
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  if (process.env.AGENT_MAIL_TEST_SCREENSHOT)
    await page.screenshot({
      path: process.env.AGENT_MAIL_TEST_SCREENSHOT + "-teams-mobile.png",
      fullPage: true,
    });
  await page.setViewportSize({ width: 1200, height: 850 });
  await page.emulateMedia({ colorScheme: "light" });
  if (process.env.AGENT_MAIL_TEST_SCREENSHOT)
    await page.screenshot({
      path: process.env.AGENT_MAIL_TEST_SCREENSHOT + "-teams-desktop.png",
      fullPage: true,
    });
  assert.equal(await orchardCard.locator(":scope > summary > .team-badge").evaluate((badge) => badge.getBoundingClientRect().width), 48);
  assert.equal(await orchardCard.locator(".contact .avatar").first().evaluate((image) => image.getBoundingClientRect().width), 48);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await orchardCard
    .getByRole("button", { name: "Message team", exact: true })
    .click();
  await page.locator("#editor").waitFor({ state: "visible" });
  assert.equal(await page.locator("#to").inputValue(), "@team/orchard");
  await recipients.locator(".team-card > summary").filter({ hasText: "Orchard crew" }).waitFor();
  assert.equal(await recipients.getByRole("button", { name: "Message team", exact: true }).count(), 0);
  await page.locator("#delete-draft").click();
  await page.getByText("Draft deleted.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Teams", exact: true }).click();
  await teamsPage
    .getByText("2 teams · 1 active · 1 archived", { exact: true })
    .waitFor();
  await page.locator("#team-search").fill("Orchard crew");
  await page.locator("#team-search").press("Enter");
  await teamsPage
    .getByText("1 team · 1 active · 0 archived", { exact: true })
    .waitFor();
  assert.equal(await teamsPage.locator(".team-card").count(), 1);
  await page.locator("#team-search").fill("no such team");
  await page.locator("#team-search").press("Enter");
  await teamsPage
    .getByText("No teams match this search.", { exact: true })
    .waitFor();
  await page.locator("#all-teams").click();
  await teamsPage
    .getByText("2 teams · 1 active · 1 archived", { exact: true })
    .waitFor();
  await page.route("**/api/teams?*", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "Fixture team registry failure" }),
    }),
  );
  await page.locator("#refresh").click();
  await teamsPage
    .getByText("Team lookup unavailable: Fixture team registry failure", {
      exact: true,
    })
    .waitFor();
  assert.equal(await teamsPage.locator(".team-card").count(), 0);
  await page.unroute("**/api/teams?*");
  await page.route("**/api/teams?*", (route) =>
    route.fulfill({ contentType: "application/json", body: "[]" }),
  );
  await page.locator("#refresh").click();
  await teamsPage
    .getByText("No teams found. Create one with agent-team.", { exact: true })
    .waitFor();
  await page.unroute("**/api/teams?*");
  await page.locator("#refresh").click();
  await teamsPage
    .getByText("2 teams · 1 active · 1 archived", { exact: true })
    .waitFor();
  let releaseSlow, markSlowStarted;
  const slowStarted = new Promise((resolve) => {
    markSlowStarted = resolve;
  });
  const slowGate = new Promise((resolve) => {
    releaseSlow = resolve;
  });
  const snapshot = team("list", "--json");
  await page.route("**/api/teams?*", async (route) => {
    if (new URL(route.request().url()).searchParams.get("q") !== "slow")
      return route.continue();
    markSlowStarted();
    await slowGate;
    await route.fulfill({ contentType: "application/json", body: snapshot });
  });
  await page.locator("#team-search").fill("slow");
  await page.locator("#team-search").press("Enter");
  await slowStarted;
  await page.locator("#team-search").fill("Orchard");
  await page.locator("#team-search").press("Enter");
  await teamsPage
    .getByText("1 team · 1 active · 0 archived", { exact: true })
    .waitFor();
  const slowResponse = page.waitForResponse(
    (response) => new URL(response.url()).searchParams.get("q") === "slow",
  );
  releaseSlow();
  await (await slowResponse).finished();
  await page.waitForTimeout(100);
  assert.equal(await teamsPage.locator(".team-card").count(), 1);
  assert.equal(
    await page.locator("#team-status").textContent(),
    "1 team · 1 active · 0 archived",
  );
  await page.unroute("**/api/teams?*");
  const safeTeam = await page.evaluate(() => {
    const element = teamCard({
      handle: "@team/test",
      name: '<img src=x onerror="alert(1)">',
      purpose: "<script>bad()</script>",
      status: "active",
      coordinator: "@+fixture-agent",
      members: [],
      history: [],
      scratchpad: "/fixture",
    });
    return {
      text: element.textContent,
      unsafe: element.querySelectorAll("img,script").length,
    };
  });
  assert(safeTeam.text.includes("<script>bad()</script>"));
  assert.equal(safeTeam.unsafe, 0);
  // Installed app: the token must survive a launch at "/" without the fragment,
  // and new inbox mail must notify only while the window lacks focus.
  const app = await browser.newContext({ viewport: { width: 1000, height: 800 } });
  await app.grantPermissions(["notifications"], { origin: new URL(url).origin });
  await app.addInitScript(() => {
    window.__notes = [];
    window.__focused = true;
    Document.prototype.hasFocus = () => window.__focused;
    ServiceWorkerRegistration.prototype.showNotification = function (title, options) {
      window.__notes.push({ title, ...options });
      return Promise.resolve();
    };
  });
  const installed = await app.newPage();
  const appErrors = [];
  installed.on("pageerror", (e) => appErrors.push(e.message));
  await installed.goto(url);
  await installed.getByText("No messages here.").waitFor();
  await installed.goto(new URL("/", url).href);
  await installed.getByText("No messages here.").waitFor();
  // Throws if the relaunched page lost its authorization.
  await installed.evaluate(() => api("messages?folder=inbox&q="));
  const manifest = await installed.evaluate(async () => {
    const link = document.querySelector('link[rel="manifest"]').href;
    const worker = await navigator.serviceWorker.ready;
    return { manifest: await (await fetch(link)).json(), scope: worker.scope };
  });
  assert.equal(manifest.manifest.display, "standalone");
  assert.equal(manifest.scope, new URL("/", url).href);
  assert.equal(await installed.locator("#notify-button").isHidden(), true);
  const notifier = join(humans, "josh/.web-notifier");
  await rm(notifier, { force: true });
  await installed.evaluate(() => checkNewMail());
  await readFile(notifier);
  await installed.evaluate(() => checkNewMail());
  cli("send", "--from", "alder-turner", "--to", "@josh", "--subject", "Focused arrival", "--body", "Seen already.");
  await installed.evaluate(() => checkNewMail());
  assert.deepEqual(await installed.evaluate(() => window.__notes), []);
  await installed.evaluate(() => (window.__focused = false));
  const backgroundId = cli("send", "--from", "alder-turner", "--to", "@josh", "--subject", "Background arrival", "--body", "Notify me.");
  await installed.evaluate(() => checkNewMail());
  await installed.evaluate(() => checkNewMail());
  const notes = await installed.evaluate(() => window.__notes);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].body, "Background arrival");
  assert.match(notes[0].title, /alder-turner/);
  assert.match(notes[0].tag, /^inbox:/);
  await installed.evaluate((data) => openMail(data), notes[0].data);
  await installed.getByRole("heading", { name: "Background arrival" }).waitFor();
  await installed.goto(new URL("/?open=" + encodeURIComponent(notes[0].tag), url).href);
  await installed.locator("#reader").waitFor({ state: "visible" });
  assert.equal(new URL(installed.url()).search, "");
  // A reply arriving while the thread is open appends without disturbing it.
  await installed.locator("#thread details.message").first().waitFor();
  await installed.locator("#reply").click();
  await installed.locator("#editor").waitFor({ state: "visible" });
  await installed.locator("#body").fill("Draft in progress.");
  await installed.evaluate(() => (document.querySelector("#thread details.message").open = false));
  cli("send", "--from", "birch-weaver", "--to", "@josh", "--in-reply-to", backgroundId, "--subject", "Re: Background arrival", "--body", "Live reply.");
  await installed.evaluate(() => refreshThread());
  await installed.frameLocator("#thread iframe").last().getByText("Live reply.").waitFor();
  const live = await installed.evaluate(() => ({
    count: document.querySelectorAll("#thread details.message").length,
    firstOpen: document.querySelector("#thread details.message").open,
    body: composer.value(),
    status: document.getElementById("status").textContent,
    editor: !document.getElementById("editor").hidden,
  }));
  assert.deepEqual(live, { count: 2, firstOpen: false, body: "Draft in progress.", status: "New message from birch-weaver.", editor: true });
  await installed.evaluate(() => refreshThread());
  assert.equal(await installed.locator("#thread details.message").count(), 2);
  assert.deepEqual(appErrors, []);
  await app.close();
  const avatarFile = join(agents, "alder-turner-12345678/avatar.svg");
  const avatarSvg = process.env.AGENT_MAIL_TEST_AVATAR_SVG
    ? await readFile(process.env.AGENT_MAIL_TEST_AVATAR_SVG, "utf8")
    : '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="12" fill="#002FA7"/></svg>';
  await writeFile(avatarFile, avatarSvg);
  await page.reload();
  const customAvatar = page.locator('.sender .avatar-wrap[data-key="agent:alder-turner"] img').first();
  await page.waitForFunction(() => {
    const img = document.querySelector('.sender .avatar-wrap[data-key="agent:alder-turner"] img');
    return img?.src.startsWith("data:image/svg+xml;base64,") && img.complete && img.naturalWidth > 0;
  });
  const customSrc = await customAvatar.getAttribute("src");
  assert.match(Buffer.from(customSrc.split(",")[1], "base64").toString(), /#002FA7/);
  assert.equal(await customAvatar.getAttribute("width"), "28");
  assert.equal(await customAvatar.getAttribute("aria-hidden"), "true");
  assert.equal(await customAvatar.locator("..").locator(".team-badge").count(), 1);
  await page.evaluate(() => {
    const alias = avatar("alder-turner-12345678");
    alias.id = "avatar-alias-test";
    document.body.append(alias);
  });
  await page.waitForFunction((src) => document.querySelector("#avatar-alias-test img").src === src, customSrc);
  assert.equal(await page.evaluate(() => scratchpadAvatar("@+alder-turner-87654321")), "");
  const agentJoshPad = join(agents, "josh-abcdef12");
  await mkdir(agentJoshPad);
  await writeFile(join(env.AGENT_IDENTITIES_DIR, "josh"), "abcdef12-0000-0000-0000-000000000001\n");
  await writeFile(join(agentJoshPad, "avatar.svg"), avatarSvg);
  await page.evaluate(() => {
    const agent = avatar("@+josh");
    agent.id = "agent-josh-avatar-test";
    document.body.append(agent);
  });
  await page.waitForFunction(() => document.querySelector("#agent-josh-avatar-test img").src.startsWith("data:image/svg+xml;base64,"));
  assert.equal(await page.evaluate(() => avatarImage("@josh").getAttribute("src")), "/josh-avatar.png");
  for (const scheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: scheme });
    if (process.env.AGENT_MAIL_AVATAR_SCREENSHOT)
      await customAvatar.screenshot({ path: process.env.AGENT_MAIL_AVATAR_SCREENSHOT + "-" + scheme + ".png" });
    assert.equal(await customAvatar.evaluate((img) => img.naturalWidth > 0), true);
  }
  await writeFile(avatarFile, avatarSvg.replaceAll("#002FA7", "#FF7900"));
  await page.reload();
  await page.waitForFunction((before) => {
    const img = document.querySelector('.sender .avatar-wrap[data-key="agent:alder-turner"] img');
    return img?.src.startsWith("data:image/svg+xml;base64,") && img.src !== before && img.complete && img.naturalWidth > 0;
  }, customSrc);
  await writeFile(avatarFile, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><script>parent.document.body.dataset.compromised="avatar"</script></svg>');
  await page.reload();
  await page.waitForFunction(() => {
    const img = document.querySelector('.sender .avatar-wrap[data-key="agent:alder-turner"] img');
    return img?.src.startsWith("data:image/svg+xml;charset=utf-8,") && img.complete && img.naturalWidth > 0;
  });
  assert.equal(await page.evaluate(() => document.body.dataset.compromised), undefined);
  await rm(avatarFile);
  await page.reload();
  await page.waitForFunction(() => document.querySelector('.sender .avatar-wrap[data-key="agent:alder-turner"] img')?.src.startsWith("data:image/svg+xml;charset=utf-8,"));
  assert.deepEqual(remote, []);
  assert.deepEqual(errors, []);
  console.log(
    "Browser tests passed: stable reader sizing at fractional zoom, scratchpad SVG avatars with alias/update/unsafe/missing fallback, local avatars/favicon/team badges, read without archive, Mermaid labels, inert hostile HTML, blocked remote images, reply-all, direct sending and repeat guard, attachments, Sent/thread, archive/search, contacts/participant cards, relative recent dates with exact-time metadata, live registered-session transcript updates with inert content and preserved disclosures, inline reply context and navigation, live thread replies, draft save/delete races and reload, shortcuts, Vim mappings/leader/undo/redo, local keyword completion, installable app token/worker/notifications, light/dark and mobile.",
  );
} finally {
  await browser?.close();
  processServer.kill("SIGTERM");
  await once(processServer, "exit").catch(() => {});
  await rm(tmp, { recursive: true, force: true });
}
