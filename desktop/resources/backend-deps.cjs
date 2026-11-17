"use strict";

/*
 * Where the desktop's backend finds its dependencies. The staging script
 * (desktop/scripts/lib/stage.mjs) packs the backend's production node_modules
 * into one archive, `<resources>/backend/node_modules.asar`, whose root holds
 * a `node_modules` directory. One file instead of about 18,000 is what makes
 * the installer, and the first start after it, fast on Windows, where every
 * file written is also scanned. The backend runs on Monize.exe with
 * ELECTRON_RUN_AS_NODE, and Electron's `fs` reads inside an .asar archive as
 * if it were a directory; its one native module is left beside the archive in
 * `node_modules.asar.unpacked/`, which Electron loads from transparently.
 *
 * Node's own lookup walks up from the requiring file looking for a directory
 * named `node_modules`, so it never looks inside the archive from dist/. This
 * preload, loaded with `--require` into the backend's three processes only
 * (src/supervisor/backend-deps.ts), adds one rule: a bare specifier that the
 * ordinary lookup cannot find is resolved again as if it were required or
 * imported from the archive's root. Inside the archive the ordinary lookup
 * works unchanged, because its directory really is called `node_modules`.
 *
 * - It changes nothing that resolves today: only a lookup that has already
 *   failed is retried, so a relative path, an absolute path, a `node:` or
 *   `file:` URL and a package's own `#imports` are never redirected.
 * - require() is retried with require's own conditions (`require.resolve`
 *   with the archive as its search root); import() is retried through the
 *   default ESM resolver with the archive as the parent, so `exports` maps
 *   are honoured either way.
 * - Without the archive (a layout this preload does not expect) it does
 *   nothing, and a missing dependency fails exactly as it would without it.
 */

const fs = require("fs");
const Module = require("module");
const path = require("path");
const { pathToFileURL } = require("url");

/** Where staging puts the archive, relative to this file in `<resources>/shell/`. */
const ARCHIVE = path.join(__dirname, "..", "backend", "node_modules.asar");
/**
 * A file at the archive's root: an import resolved from it starts its lookup
 * in `<archive>/node_modules`. It does not have to exist. Built from literals
 * like ARCHIVE, never from a runtime value.
 */
const ANCHOR_URL = pathToFileURL(
  path.join(
    __dirname,
    "..",
    "backend",
    "node_modules.asar",
    "resolve-anchor.js",
  ),
).href;

function isBare(specifier) {
  return !(
    specifier.startsWith(".") ||
    specifier.startsWith("#") ||
    specifier.includes(":") ||
    path.isAbsolute(specifier)
  );
}

function installResolver() {
  Module.registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        if (!isBare(specifier)) throw error;
        if (error.code === "MODULE_NOT_FOUND") {
          let file;
          try {
            file = require.resolve(specifier, { paths: [ARCHIVE] });
          } catch {
            throw error;
          }
          return { url: pathToFileURL(file).href, shortCircuit: true };
        }
        if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
        try {
          return nextResolve(specifier, { ...context, parentURL: ANCHOR_URL });
        } catch {
          throw error;
        }
      }
    },
  });
}

if (fs.existsSync(ARCHIVE)) installResolver();
