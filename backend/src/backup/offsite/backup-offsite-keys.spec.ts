import {
  offsiteArtifactFileName,
  offsiteObjectKey,
} from "./backup-offsite-keys";

/**
 * The name an off-machine copy is addressed by, both directions
 * (`docs/specs/backup-off-machine.md` section 6).
 *
 * The round-trip is the part worth pinning: the retry sweep holds a durable row
 * and has to find the artifact on disk again from the key alone, so a change to
 * either function that the other did not learn about turns every outstanding
 * copy into "artifact no longer on disk" -- terminal, and wrong.
 */

const USER_ID = "22222222-2222-4222-8222-222222222222";
const DIGEST = "9f3c1a2b4d5e" + "0".repeat(52);

describe("the off-site object key", () => {
  it("shards by user and disambiguates by digest", () => {
    expect(
      offsiteObjectKey(USER_ID, "monize-backup-daily-2026-09-14.mzbe", DIGEST),
    ).toBe(`22/22/${USER_ID}/monize-backup-daily-2026-09-14-9f3c1a2b4d5e.mzbe`);
  });

  it("distinguishes two artifacts of the same day", () => {
    // The append-only rule meeting a same-day re-export: different bytes land
    // under a different key and both recovery points are kept, because the
    // destination cannot be asked to replace one.
    const first = offsiteObjectKey(
      USER_ID,
      "monize-backup-daily-2026-09-14.mzbe",
      DIGEST,
    );
    const second = offsiteObjectKey(
      USER_ID,
      "monize-backup-daily-2026-09-14.mzbe",
      "71aa9c0d1e2f" + "0".repeat(52),
    );
    expect(first).not.toBe(second);
  });

  it("keeps a monthly artifact's own name", () => {
    expect(
      offsiteObjectKey(USER_ID, "monize-backup-monthly-26-09.mzbe", DIGEST),
    ).toContain("monize-backup-monthly-26-09-9f3c1a2b4d5e.mzbe");
  });

  it("refuses an id that cannot be sharded", () => {
    // The shard segments are path segments; an id outside the safe alphabet
    // would be a traversal an append-only destination could never un-write.
    expect(() =>
      offsiteObjectKey("../etc", "monize-backup-daily-2026-09-14.mzbe", DIGEST),
    ).toThrow(/off-site object key/);
  });
});

describe("the artifact filename behind a key", () => {
  it("round-trips every published tier", () => {
    for (const filename of [
      "monize-backup-daily-2026-09-14.mzbe",
      "monize-backup-weekly-2026-09-14.mzbe",
      "monize-backup-monthly-26-09.mzbe",
    ]) {
      expect(
        offsiteArtifactFileName(
          "s3",
          offsiteObjectKey(USER_ID, filename, DIGEST),
          DIGEST,
        ),
      ).toBe(filename);
    }
  });

  it("round-trips a two-part extension", () => {
    // A `.json.gz` artifact never leaves the machine (INV-BACKUP-002), but it
    // does get a `skipped-unencrypted` row, and that row's key has to name the
    // artifact it is about.
    const filename = "monize-backup-daily-2026-09-14.json.gz";
    expect(
      offsiteArtifactFileName(
        "s3",
        offsiteObjectKey(USER_ID, filename, DIGEST),
        DIGEST,
      ),
    ).toBe(filename);
  });

  it("takes the email destination's key as the filename", () => {
    expect(
      offsiteArtifactFileName(
        "email",
        "monize-backup-daily-2026-09-14.mzbe",
        DIGEST,
      ),
    ).toBe("monize-backup-daily-2026-09-14.mzbe");
  });

  it("returns a key it did not compose unchanged", () => {
    // No guess: the caller's own "no such artifact" handling is what reports it.
    expect(
      offsiteArtifactFileName("s3", "a/b/something-else.mzbe", DIGEST),
    ).toBe("something-else.mzbe");
  });
});
