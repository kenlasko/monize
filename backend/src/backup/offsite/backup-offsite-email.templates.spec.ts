import { englishEmailT } from "../../i18n/email-translator";
import { numberFormatterForLocale } from "../../common/number-locale.util";
import {
  backupOffsiteCopyTemplate,
  backupOffsiteTooLargeTemplate,
} from "./backup-offsite-email.templates";

const MIB = 1024 * 1024;

/** A translator that answers every key, so an unresolved key is visible. */
const keyEchoT = (key: string): string => `[${key}]`;

/** A translator that records what it was asked for and returns the English. */
function recordingT(): { t: typeof englishEmailT; keys: string[] } {
  const keys: string[] = [];
  return {
    keys,
    t: (key, fallback) => {
      keys.push(key);
      return fallback;
    },
  };
}

describe("backupOffsiteCopyTemplate", () => {
  const data = {
    filename: "monize-backup-daily-2026-09-14.mzbe",
    sizeBytes: 3 * MIB + Math.round(0.5 * MIB),
    digest: "a".repeat(64),
    tier: "daily" as const,
    dateLabel: "2026-09-14",
  };

  it("says what the mail is, that it is encrypted, and how to restore it", () => {
    const { subject, html } = backupOffsiteCopyTemplate(englishEmailT, data);

    expect(subject).toContain("monize-backup-daily-2026-09-14.mzbe");
    expect(html).toContain("Your Monize backup is attached");
    expect(html).toContain("the automatic daily backup");
    expect(html).toContain("2026-09-14");
    expect(html).toContain("encrypted with your Monize backup password");
    expect(html).toContain("cannot be opened without that password");
    expect(html).toContain("Settings, Backup &amp; Restore");
  });

  it("carries the size and the SHA-256 the recipient can verify against", () => {
    const { html } = backupOffsiteCopyTemplate(englishEmailT, data);

    expect(html).toContain("3.5 MiB");
    expect(html).toContain("a".repeat(64));
  });

  it("formats the size in the recipient's number convention", () => {
    const { html } = backupOffsiteCopyTemplate(
      englishEmailT,
      data,
      numberFormatterForLocale("pl-PL"),
    );

    // Polish writes the decimal comma; `escapeHtml` encodes the non-breaking
    // space Intl puts before the unit, so only the figure is asserted.
    expect(html).toContain("3,5");
    expect(html).toContain("MiB");
  });

  it("names the tier for a reader", () => {
    expect(
      backupOffsiteCopyTemplate(englishEmailT, { ...data, tier: "monthly" })
        .html,
    ).toContain("the automatic monthly backup");
    expect(
      backupOffsiteCopyTemplate(englishEmailT, { ...data, tier: "weekly" })
        .html,
    ).toContain("the automatic weekly backup");
  });

  it("escapes every interpolated value", () => {
    const { html } = backupOffsiteCopyTemplate(englishEmailT, {
      ...data,
      filename: '<script>alert("x")</script>.mzbe',
      digest: "<img src=x onerror=1>",
      dateLabel: "<b>today</b>",
    });

    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>today</b>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("resolves every string through the translator", () => {
    const { t, keys } = recordingT();
    backupOffsiteCopyTemplate(t, data);

    expect(keys).toEqual(
      expect.arrayContaining([
        "emails.backupOffsite.copySubject",
        "emails.backupOffsite.copyHeading",
        "emails.backupOffsite.copyIntro",
        "emails.backupOffsite.copyEncrypted",
        "emails.backupOffsite.copyRestore",
        "emails.backupOffsite.copyVerify",
        "emails.backupOffsite.labelFile",
        "emails.backupOffsite.labelSize",
        "emails.backupOffsite.labelTier",
        "emails.backupOffsite.labelDigest",
        "emails.backupOffsite.tierDaily",
      ]),
    );
    // Nothing is composed from a hardcoded English literal: a catalogue that
    // answered every key leaves no English prose in the body.
    const translated = backupOffsiteCopyTemplate(keyEchoT, data);
    expect(translated.html).not.toContain("Your Monize backup is attached");
    expect(translated.subject).toBe("[emails.backupOffsite.copySubject]");
  });
});

describe("backupOffsiteTooLargeTemplate", () => {
  const data = {
    filename: "monize-backup-daily-2026-09-14.mzbe",
    sizeBytes: 31 * MIB,
    maxBytes: 20 * MIB,
    digest: "b".repeat(64),
  };

  // Spec section 8, example 6: a 31 MiB artifact against a 20 MiB bound.
  it("names the file, its size, the bound, and that no bytes were sent", () => {
    const { subject, html } = backupOffsiteTooLargeTemplate(
      englishEmailT,
      data,
    );

    expect(subject).toContain("was too large to email");
    expect(subject).toContain("monize-backup-daily-2026-09-14.mzbe");
    expect(html).toContain("Your Monize backup was not emailed");
    expect(html).toContain("31.0 MiB");
    expect(html).toContain("20.0 MiB");
    expect(html).toContain("BACKUP_EMAIL_MAX_BYTES");
    expect(html).toContain("Nothing was attached to this email");
    expect(html).toContain("no download link is offered");
  });

  it("says the local and S3 copies are unaffected", () => {
    const { html } = backupOffsiteTooLargeTemplate(englishEmailT, data);

    expect(html).toContain("The copy on this server is unaffected");
    expect(html).toContain("S3 destination");
  });

  it("escapes every interpolated value", () => {
    const { html } = backupOffsiteTooLargeTemplate(englishEmailT, {
      ...data,
      filename: "<script>alert(1)</script>.mzbe",
      digest: "<img src=x onerror=1>",
    });

    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
  });

  it("resolves every string through the translator", () => {
    const { t, keys } = recordingT();
    backupOffsiteTooLargeTemplate(t, data);

    expect(keys).toEqual(
      expect.arrayContaining([
        "emails.backupOffsite.tooLargeSubject",
        "emails.backupOffsite.tooLargeHeading",
        "emails.backupOffsite.tooLargeIntro",
        "emails.backupOffsite.tooLargeNoBytes",
        "emails.backupOffsite.tooLargeUnaffected",
        "emails.backupOffsite.tooLargeWhatToDo",
        "emails.backupOffsite.labelLimit",
      ]),
    );
    const translated = backupOffsiteTooLargeTemplate(keyEchoT, data);
    expect(translated.html).not.toContain("Your Monize backup was not emailed");
  });
});
