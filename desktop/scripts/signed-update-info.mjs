// Brings the updater files in release/ back in line with a signed installer.
//
//   node scripts/signed-update-info.mjs [release-dir]
//
// CI signs Monize-Setup-<version>.exe after electron-builder has written its
// .blockmap and latest.yml (or beta.yml), and signing changes the file. This
// refuses an installer with no signature, then rebuilds the blockmap with
// electron-builder's own code and writes the new sha512 and size into every
// feed file beside it. desktop/README.md, "Code signing", has the whole flow.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileHasSignature } from "./lib/pe.mjs";
import { buildBlockMap, rewriteUpdateInfo } from "./lib/update-info.mjs";

const out = (text) => process.stdout.write(`${text}\n`);

async function main() {
  const dir = path.resolve(process.argv[2] ?? "release");
  const installers = fs
    .readdirSync(dir)
    .filter((name) => /^Monize-Setup-.+\.exe$/.test(name));
  if (installers.length !== 1) {
    throw new Error(
      `expected one Monize-Setup-*.exe in ${dir}, found ${installers.length}`,
    );
  }
  const [file] = installers;
  const installer = path.join(dir, file);
  if (!fileHasSignature(installer)) {
    throw new Error(`${file} has no Authenticode signature`);
  }

  // "gzip" is what createBlockmap passes for a separate .blockmap file. With
  // no regions (nsis.differentialPackage is not "store-asar") the chunking is
  // the default, as in the build.
  const { sha512, size } = await buildBlockMap(
    installer,
    "gzip",
    `${installer}.blockmap`,
  );
  out(`${file}.blockmap rebuilt: ${size} bytes, sha512 ${sha512}`);

  const feeds = fs
    .readdirSync(dir)
    .filter((name) => /^(latest|beta)\.yml$/.test(name));
  if (feeds.length === 0) {
    throw new Error(`no latest.yml or beta.yml in ${dir}`);
  }
  for (const feed of feeds) {
    const at = path.join(dir, feed);
    fs.writeFileSync(
      at,
      rewriteUpdateInfo(fs.readFileSync(at, "utf8"), { file, sha512, size }),
    );
    out(`${feed} updated`);
  }
}

main().catch((error) => {
  process.stderr.write(`signed-update-info: ${error.message}\n`);
  process.exit(1);
});
