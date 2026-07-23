import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ReleaseNotesService } from "./release-notes.service";

describe("ReleaseNotesService", () => {
  let tmpRoot: string;
  let notesDir: string;
  let service: ReleaseNotesService;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "release-notes-"));
    notesDir = path.join(tmpRoot, "release-notes");
    fs.mkdirSync(notesDir);
    // The service resolves the notes directory from process.cwd()/release-notes
    // (its bundled location in the image); point cwd at our temp root so tests
    // are isolated from the repo's real docs/release-notes.
    jest.spyOn(process, "cwd").mockReturnValue(tmpRoot);
    service = new ReleaseNotesService();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writeNotes(version: string, body: string): void {
    fs.writeFileSync(path.join(notesDir, `${version}.md`), body, "utf-8");
  }

  it("reads and parses the notes for a version", () => {
    writeNotes(
      "1.2.3",
      ["# v1.2.3", "", "Hello world.", "", "## Feature", "", "Body."].join(
        "\n",
      ),
    );

    const notes = service.readNotes("1.2.3");

    expect(notes).not.toBeNull();
    expect(notes?.version).toBe("1.2.3");
    expect(notes?.intro).toBe("Hello world.");
    expect(notes?.sections[0].heading).toBe("Feature");
    expect(notes?.releaseUrl).toBe(
      "https://github.com/kenlasko/monize/releases/tag/v1.2.3",
    );
  });

  it("returns null when no notes file exists for the version", () => {
    expect(service.readNotes("9.9.9")).toBeNull();
  });

  it("rejects versions that are not plain semver (no path traversal)", () => {
    expect(service.readNotes("../secret")).toBeNull();
    expect(service.readNotes("not-a-version")).toBeNull();
  });

  it("returns null when no release-notes directory can be found", () => {
    // Point cwd somewhere with no release-notes dir; the __dirname candidate
    // (backend/release-notes) does not exist in the source tree either.
    jest.spyOn(process, "cwd").mockReturnValue(path.join(tmpRoot, "nowhere"));

    expect(service.readNotes("1.2.3")).toBeNull();
  });

  it("caches the current version's notes after the first read", () => {
    writeNotes(service.currentVersion, ["# v", "", "Cached.", ""].join("\n"));

    const first = service.getForCurrentVersion();
    // Change the file on disk; a cached read must still return the first parse.
    writeNotes(service.currentVersion, ["# v", "", "Changed.", ""].join("\n"));
    const second = service.getForCurrentVersion();

    expect(first).toBe(second);
    expect(second?.intro).toBe("Cached.");
  });

  it("caches a null result too (a later file does not override it)", () => {
    // No file for the current version yet -> null, and cached.
    expect(service.getForCurrentVersion()).toBeNull();

    writeNotes(service.currentVersion, ["# v", "", "Too late.", ""].join("\n"));
    expect(service.getForCurrentVersion()).toBeNull();
  });
});
