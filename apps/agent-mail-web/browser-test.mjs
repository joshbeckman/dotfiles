import { chromium } from "playwright-core";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
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
};
await mkdir(join(env.XDG_CONFIG_HOME, "nvim"), { recursive: true });
const keywordFile = join(env.XDG_CONFIG_HOME, "nvim/keywords.txt");
await writeFile(keywordFile, "@+alder-turner\n@+alder-weaver\nname.with_dot\n");
await mkdir(env.AGENT_IDENTITIES_DIR);
await mkdir(env.PI_SESSIONS_DIR);
const sid = "12345678-0000-0000-0000-000000000001";
await writeFile(join(env.AGENT_IDENTITIES_DIR, "alder-turner"), sid + "\n");
await writeFile(
  join(env.PI_SESSIONS_DIR, "2026-01-01T00-00-00Z_" + sid + ".jsonl"),
  [
    { type: "session", cwd: "/fixture/orchard" },
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
    { type: "message", message: { content: "orchard incident analysis" } },
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
  browser = await chromium.launch(
    process.env.CHROME_EXECUTABLE
      ? { executablePath: process.env.CHROME_EXECUTABLE, headless: true }
      : { channel: "chrome", headless: true },
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
      ].map((address) => [address, avatar(address).getAttribute("src")]),
    ),
  );
  assert.equal(icons.josh, "/josh-avatar.png");
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
  await page
    .getByRole("button", { name: /alder-turner Markdown conversation/ })
    .click();
  assert.equal(
    await page.locator("#thread summary .avatar").first().getAttribute("src"),
    icons["alder-turner"],
  );
  const sidebar = page.getByRole("complementary", {
    name: "Thread participants",
  });
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
  await page.locator("#preview-button").click();
  await page
    .frameLocator("#preview iframe")
    .getByRole("img", { name: "pixel.png" })
    .waitFor();
  await assertReaderFits(page.frameLocator("#preview iframe"));
  // Settle the scroll after preview sizing before aiming the send click.
  await page.locator("#send").scrollIntoViewIfNeeded();
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
  await page.locator("#send").click();
  await page.locator("#reader").waitFor({ state: "visible" });
  await page.waitForFunction(
    () => document.querySelectorAll("#thread details.message").length === 3,
  );
  await page
    .frameLocator("#thread iframe")
    .last()
    .getByText("Reply resumed from a saved draft.", { exact: true })
    .waitFor();
  assert.equal(await page.locator("#archive").isDisabled(), true);
  await page.getByRole("button", { name: "Contacts", exact: true }).click();
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
  await page.locator("#to").fill("@+alder-turner");
  await page.locator("#subject").fill("Saved draft");
  await page.locator("#body").fill("First version");
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
  // Typing Gmail shortcut letters in the composer must not navigate or archive.
  await page.locator("#body").press("e");
  assert.equal(await page.locator("#editor").isVisible(), true);
  const beforeSend = await page.evaluate(() => composer.value());
  await page.locator("#body").press("Control+Enter");
  await page.getByRole("heading", { name: "Sent", exact: true }).waitFor();
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
  assert.deepEqual(remote, []);
  assert.deepEqual(errors, []);
  console.log(
    "Browser tests passed: local avatars/favicon, read without archive, Mermaid labels, inert hostile HTML, blocked remote images, reply-all, attachments, Sent/thread, archive/search, contacts/participant cards, inline reply context and navigation, draft save/delete races and reload, shortcuts, Vim mappings/leader/undo/redo, local keyword completion, light/dark and mobile.",
  );
} finally {
  await browser?.close();
  processServer.kill("SIGTERM");
  await once(processServer, "exit").catch(() => {});
  await rm(tmp, { recursive: true, force: true });
}
