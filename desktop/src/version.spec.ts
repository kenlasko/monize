import { readFileSync } from "fs";
import { join } from "path";

const REPO_ROOT = join(__dirname, "..", "..");

function versionOf(layer: string): string {
  const manifest = JSON.parse(
    readFileSync(join(REPO_ROOT, layer, "package.json"), "utf8"),
  ) as { version: string };
  return manifest.version;
}

describe("package versions", () => {
  it("carries one version across the backend, frontend and desktop manifests", () => {
    const versions = {
      backend: versionOf("backend"),
      frontend: versionOf("frontend"),
      desktop: versionOf("desktop"),
    };
    expect(versions.frontend).toBe(versions.backend);
    expect(versions.desktop).toBe(versions.backend);
  });
});
