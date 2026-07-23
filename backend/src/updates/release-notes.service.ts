import { Injectable, Logger } from "@nestjs/common";
import * as fs from "fs";
import * as path from "path";
import { parseReleaseNotes, ReleaseNotes } from "./release-notes.parser";

// The running version comes from the backend package.json at build/run time,
// matching how UpdatesService and the MCP server resolve it.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const backendPkg = require("../../package.json") as { version: string };

const RELEASE_URL_BASE = "https://github.com/kenlasko/monize/releases/tag/v";

// Only plain MAJOR.MINOR.PATCH(-suffix) versions map to a notes file. Guards
// the file lookup against anything path-like even though the version is always
// the trusted package.json value in production.
const VERSION_RE = /^\d+\.\d+\.\d+[\w.-]*$/;

/**
 * Serves the pre-written release notes for the running app version from the
 * committed `docs/release-notes/<version>.md` files. The notes are bundled into
 * the backend image (see the Dockerfile), so this never depends on GitHub's
 * network API — important for internet-isolated instances.
 */
@Injectable()
export class ReleaseNotesService {
  private readonly logger = new Logger(ReleaseNotesService.name);
  readonly currentVersion: string = backendPkg.version;

  // `undefined` = not loaded yet; `null` = loaded, no notes file present.
  private cache: ReleaseNotes | null | undefined = undefined;

  /**
   * Return the parsed release notes for the running version, or `null` when no
   * notes file exists for it. Cached after the first read since the bundled
   * file never changes at runtime.
   */
  getForCurrentVersion(): ReleaseNotes | null {
    if (this.cache === undefined) {
      this.cache = this.readNotes(this.currentVersion);
    }
    return this.cache;
  }

  /**
   * Read and parse the notes for a specific version. Exposed (uncached) mainly
   * for testing; production reads go through `getForCurrentVersion`.
   */
  readNotes(version: string): ReleaseNotes | null {
    if (!VERSION_RE.test(version)) {
      return null;
    }

    const dir = this.resolveDirectory();
    if (!dir) {
      this.logger.warn(
        "Release-notes directory not found; the What's New digest will be empty",
      );
      return null;
    }

    const file = path.join(dir, `${version}.md`);
    if (!fs.existsSync(file)) {
      this.logger.debug(`No release notes file for version ${version}`);
      return null;
    }

    try {
      const markdown = fs.readFileSync(file, "utf-8");
      return parseReleaseNotes(
        markdown,
        version,
        `${RELEASE_URL_BASE}${version}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Failed to read release notes for ${version}: ${message}`,
      );
      return null;
    }
  }

  /**
   * Locate the release-notes directory. Mirrors db-migrate's multi-candidate
   * search so it works both in the Docker image (notes copied to `./release-notes`)
   * and in local/source runs (repo `docs/release-notes`). The notes are bundled
   * into the image at a known location, so there is no configuration knob.
   */
  private resolveDirectory(): string | null {
    const candidates = [
      path.resolve(process.cwd(), "release-notes"),
      path.resolve(__dirname, "..", "..", "release-notes"),
      path.resolve(process.cwd(), "..", "docs", "release-notes"),
      path.resolve(process.cwd(), "docs", "release-notes"),
    ];

    for (const candidate of candidates) {
      if (
        candidate &&
        fs.existsSync(candidate) &&
        fs.statSync(candidate).isDirectory()
      ) {
        return candidate;
      }
    }
    return null;
  }
}
