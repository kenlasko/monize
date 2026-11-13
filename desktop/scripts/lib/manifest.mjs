import fs from "node:fs";

const KINDS = ["copy", "backend-deps", "help-images", "postgres", "desktop"];

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
  }
  return manifest;
}

/** The distinct destinations the manifest promises, as given. */
export function destinations(manifest) {
  return manifest.entries.map((entry) => entry.to);
}
