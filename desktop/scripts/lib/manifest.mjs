import fs from "node:fs";

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
    if (!["copy", "backend-deps", "help-images", "postgres"].includes(kind)) {
      throw new Error(`${file}: unknown kind "${kind}" for ${entry.to}`);
    }
  }
  return manifest;
}

/** The distinct destinations the manifest promises, as given. */
export function destinations(manifest) {
  return manifest.entries.map((entry) => entry.to);
}
