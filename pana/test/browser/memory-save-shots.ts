// Usage: node test/browser/memory-save-shots.ts before|after OUTPUT.png
import { copyFileSync } from "node:fs";
import { loopbackOrigin } from "../../src/web/static.ts";
import { startTestPanad } from "../harness/index.ts";
import { closePage, evaluatePage, newPage, resizePage, screenshot } from "./cli.ts";
const before = process.argv[2] === "before";
const t = await startTestPanad();
let page: number | undefined;
try {
 await t.client.get("/memory/worktree");
 const id = t.runtime.newId();
 const now = t.clock.now();
 await t.runtime.db.write(async tx => {
  await tx.run("INSERT INTO participants (id, kind, url, created_at) VALUES (?, 'session', ?, ?)", id, t.runtime.url({kind:"session", id}), now);
  await tx.run("INSERT INTO sessions (id, state, depth, created_at, updated_at) VALUES (?, 'idle', 0, ?, ?)", id, now, now);
 });
 await t.client.post("/memory/files/profile.md", {content:"# Profile\n\nPrincipal engineer\n"}, {caller:id});
 page = await newPage(`${loopbackOrigin(t.panad.tcpPort!)}/#${t.panad.webToken}`);
 await resizePage(1280, 900);
 await evaluatePage(`
  await until(() => window.__pana && document.getElementById("authorize").hidden);
  location.hash = "#/memory/edit/profile.md";
  await until(() => window.__pana.memoryEditor && document.activeElement.closest("#memory-editor"));
  window.__pana.memoryEditor.load("# Profile\\n\\nSenior Staff engineer\\n");
  document.getElementById("memory-save").click();
  await until(() => ${before ? 'document.getElementById("status").textContent.includes("memory rebase conflict")' : 'location.hash === "#/memory/files/profile.md" && document.getElementById("memory-file").textContent.includes("Senior Staff")'});
  return true;
 `);
 copyFileSync(await screenshot(true), process.argv[3]!);
 console.log(`Saved ${process.argv[2]} screenshot`);
} finally {
 if (page !== undefined) await closePage(page);
 await t.close();
}
