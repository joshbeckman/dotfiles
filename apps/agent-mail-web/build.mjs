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
let licenses =
  "Bundled third-party editor and renderers. Rebuild with npm ci --ignore-scripts && npm run build.\n";
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
