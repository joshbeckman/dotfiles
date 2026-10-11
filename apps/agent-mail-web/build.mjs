import { build } from "esbuild";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
await build({
  entryPoints: ["renderers.js"],
  bundle: true,
  minify: true,
  format: "iife",
  globalName: "MailRenderers",
  outfile: "vendor.js",
  legalComments: "eof",
});
await build({
  entryPoints: ["composer.js"],
  bundle: true,
  minify: true,
  format: "iife",
  globalName: "MailComposer",
  outfile: "composer-vendor.js",
  legalComments: "eof",
});
const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
// Everything below the header is regenerated from the lockfile, so anything hand-written here
// is lost on the next build. The font notice was added by hand once and dropped by a later
// build; keeping it in the generator is what makes the file stable.
let licenses =
  "Bundled third-party editor and renderers. Rebuild with npm ci --ignore-scripts && npm run build.\n" +
  "\n" +
  "IBM Plex fonts are self-hosted in fonts/ under the SIL Open Font License 1.1,\n" +
  "with the licence text alongside them in fonts/LICENSE.txt.\n";
for (const [path, info] of Object.entries(lock.packages).sort()) {
  if (!path || info.dev || info.optional) continue;
  const pkg = JSON.parse(await readFile(join(path, "package.json"), "utf8"));
  licenses +=
    "\n\n=== " +
    pkg.name +
    " " +
    pkg.version +
    " (" +
    (pkg.license || "see below") +
    ") ===\n";
  for (const name of (await readdir(path))
    .filter((n) => /^(license|copying)(\.|$)/i.test(n))
    .sort())
    licenses += "\n" + (await readFile(join(path, name), "utf8"));
}
await writeFile("THIRD_PARTY_LICENSES.txt", licenses);
