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
  AGENT_MAIL_ROOT: agents,
  AGENT_HUMAN_MAIL_ROOT: humans,
  AGENT_IDENTITIES_DIR: join(tmp, "identities"),
  PI_SESSIONS_DIR: join(tmp, "sessions"),
};
await mkdir(env.AGENT_IDENTITIES_DIR);
await mkdir(env.PI_SESSIONS_DIR);
const sid = "12345678-0000-0000-0000-000000000001";
await writeFile(join(env.AGENT_IDENTITIES_DIR, "alder-turner"), sid + "\n");
await writeFile(
  join(env.PI_SESSIONS_DIR, "2026-01-01T00-00-00Z_" + sid + ".jsonl"),
  [
    { type: "session", cwd: "/fixture/orchard" },
    { type: "session_info", name: "Investigate orchard migrations" },
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
const processServer = spawn(join(root, "bin/agent-mail-web"), ["--no-open"], {
  env,
  stdio: ["ignore", "pipe", "inherit"],
});
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
    remote = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (r.url().startsWith("https://")) remote.push(r.url());
  });
  page.on("dialog", (d) => d.accept());
  await page.goto(url);
  await page
    .getByRole("button", { name: /alder-turner Markdown conversation/ })
    .click();
  const reader = page.frameLocator("#thread iframe").last();
  await reader.getByRole("heading", { name: "Fixture heading" }).waitFor();
  await reader.getByText("Mail", { exact: true }).waitFor();
  await reader.getByText("Reply", { exact: true }).waitFor();
  assert.equal(
    await page.evaluate(() => document.body.dataset.compromised),
    undefined,
  );
  assert.equal((await readdir(join(humans, "josh/inbox/new"))).length, 1);
  assert.deepEqual(remote, []);
  await page.locator("#reply-all").click();
  await page.locator("#editor").waitFor({ state: "visible" });
  assert.equal(
    await page.locator("#to").inputValue(),
    "alder-turner, birch-weaver",
  );
  await page.locator("#body").fill("Reply with **Markdown**.");
  await page.locator("#image").setInputFiles({
    name: "pixel.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7ZkAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  await page.waitForFunction(() =>
    document.getElementById("body").value.includes("file:"),
  );
  await page.locator("#preview-button").click();
  await page
    .frameLocator("#preview iframe")
    .getByRole("img", { name: "pixel.png" })
    .waitFor();
  await page.locator("#send").click();
  await page.getByText("Sent. A copy is retained in Sent.").waitFor();
  const sent = await readdir(join(humans, "josh/sent"));
  assert.equal(sent.length, 1);
  const copy = await readFile(join(humans, "josh/sent", sent[0]), "utf8");
  assert(copy.includes("Thread-ID: " + id));
  assert(copy.includes("Reply with **Markdown**."));
  await page.locator(".row").click();
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
  await page.getByRole("button", { name: "Contacts", exact: true }).click();
  await page
    .locator(".contact summary")
    .filter({ hasText: "@+alder-turner" })
    .click();
  await page
    .getByText("Investigate orchard migrations", { exact: true })
    .waitFor();
  await page.getByText("/fixture/orchard", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Copy resume command", exact: true })
    .waitFor();
  await page.locator("#contact-search").fill("orchard");
  await page.locator("#contact-search").press("Enter");
  await page.getByText(/1 matching sessions/).waitFor();
  assert.equal(await page.locator(".contact").count(), 1);
  await page.getByText(sid, { exact: true }).waitFor();
  await page.locator("#contact-search").fill("no-such-fixture-topic");
  await page.locator("#contact-search").press("Enter");
  await page.getByText(/0 matching sessions/).waitFor();
  assert.equal(await page.locator(".contact").count(), 0);
  await page.locator("#all-contacts").click();
  await page
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
    await page.locator("#body").inputValue(),
    "Latest version while save was in flight",
  );
  // Typing Gmail shortcut letters in the composer must not navigate or archive.
  await page.locator("#body").press("e");
  assert.equal(await page.locator("#editor").isVisible(), true);
  await page.locator("#close-draft").click();
  await page.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "g" }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "i" }));
  });
  await page.getByRole("heading", { name: "Inbox", exact: true }).waitFor();
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  assert.deepEqual(errors, []);
  console.log(
    "Browser tests passed: read without archive, Mermaid labels, inert hostile HTML, blocked remote images, reply-all, attachments, Sent/thread, archive/search, contacts, draft save race/reload, shortcuts, light/dark and mobile.",
  );
} finally {
  await browser?.close();
  processServer.kill("SIGTERM");
  await once(processServer, "exit").catch(() => {});
  await rm(tmp, { recursive: true, force: true });
}
