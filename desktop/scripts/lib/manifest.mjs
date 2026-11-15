import fs from "node:fs";
import { VC_RUNTIME_DLL } from "./vc-runtime.mjs";

const KINDS = [
  "copy",
  "backend-deps",
  "help-images",
  "postgres",
  "desktop",
  "vc-runtime",
];

/**
 * A desktop-owned file mirrors no Dockerfile line, so it must not land where
 * a layer's files do: the layers stay what the containers run.
 */
function isDesktopOnly(entry) {
  const top = entry.to.split("/")[0];
  return (
    entry.from.startsWith("desktop/") && top !== "backend" && top !== "frontend"
  );
}

/**
 * A vc-runtime entry lists the Visual C++ runtime DLLs to put beside the
 * PostgreSQL executables, so it names DLLs of that family and lands in
 * postgres/.
 */
function isVcRuntime(entry) {
  return (
    Array.isArray(entry.files) &&
    entry.files.length > 0 &&
    entry.files.every(
      (file) => typeof file === "string" && VC_RUNTIME_DLL.test(file),
    ) &&
    entry.to.split("/")[0] === "postgres"
  );
}

/** Reads and validates a staging manifest; throws on a malformed entry. */
export function loadManifest(file) {
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(manifest.entries) || manifest.entries.length === 0) {
    throw new Error(`${file}: "entries" must be a non-empty array`);
  }
  for (const entry of manifest.entries) {
    for (const key of ["from", "to", "mirrors"]) {
      if (typeof entry[key] !== "string" || entry[key] === "") {
        throw new Error(
          `${file}: every entry needs a "${key}" (${JSON.stringify(entry)})`,
        );
      }
    }
    const kind = entry.kind ?? "copy";
    if (!KINDS.includes(kind)) {
      throw new Error(`${file}: unknown kind "${kind}" for ${entry.to}`);
    }
    if (kind === "desktop" && !isDesktopOnly(entry)) {
      throw new Error(
        `${file}: a desktop entry comes from desktop/ and stages outside backend/ and frontend/ (${entry.to})`,
      );
    }
    if (kind === "vc-runtime" && !isVcRuntime(entry)) {
      throw new Error(
        `${file}: a vc-runtime entry lists lower-case Visual C++ runtime DLL names in "files" and stages under postgres/ (${entry.to})`,
      );
    }
  }
  return manifest;
}

/** The distinct destinations the manifest promises, as given. */
export function destinations(manifest) {
  return manifest.entries.map((entry) => entry.to);
}
