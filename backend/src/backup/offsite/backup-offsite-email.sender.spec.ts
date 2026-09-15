import { I18nService } from "nestjs-i18n";

import { EmailService } from "../../notifications/email.service";
import {
  BackupOffsiteEmailInput,
  BackupOffsiteEmailSender,
} from "./backup-offsite-email.sender";

const MIB = 1024 * 1024;

/**
 * The collaborator typed to the real method, so a call this suite accepts is a
 * call `EmailService` could actually serve (`docs/backend/testing.md`).
 */
type SendMail = jest.MockedFunction<EmailService["sendMail"]>;

function build(): {
  sender: BackupOffsiteEmailSender;
  sendMail: SendMail;
  translate: jest.Mock;
} {
  const sendMail = jest.fn().mockResolvedValue(undefined) as SendMail;
  const emailService = { sendMail } as unknown as EmailService;
  // Answers no key, so every string falls back to its English source -- the
  // same shape `emailTranslator` produces for a locale with no catalogue.
  const translate = jest.fn().mockImplementation((key: string) => key);
  const i18n = { translate } as unknown as I18nService;
  return {
    sender: new BackupOffsiteEmailSender(emailService, i18n),
    sendMail,
    translate,
  };
}

const input = (
  overrides: Partial<BackupOffsiteEmailInput> = {},
): BackupOffsiteEmailInput => {
  const body = overrides.body ?? Buffer.alloc(4 * MIB, 7);
  return {
    to: "owner@example.com",
    recipientLang: "en",
    filename: "monize-backup-daily-2026-09-14.mzbe",
    body,
    sizeBytes: body.length,
    digest: "c".repeat(64),
    tier: "daily",
    maxBytes: 20 * MIB,
    ...overrides,
  };
};

describe("BackupOffsiteEmailSender", () => {
  it("attaches the artifact and reports uploaded when it is under the bound", async () => {
    const { sender, sendMail } = build();
    const body = Buffer.alloc(4 * MIB, 7);

    const result = await sender.send(input({ body }));

    expect(result).toEqual({ outcome: "uploaded" });
    const [to, subject, html, options] = sendMail.mock.calls[0];
    expect(to).toBe("owner@example.com");
    expect(subject).toContain("monize-backup-daily-2026-09-14.mzbe");
    expect(html).toContain("attached");
    expect(options?.attachments).toEqual([
      {
        filename: "monize-backup-daily-2026-09-14.mzbe",
        content: body,
        contentType: "application/octet-stream",
      },
    ]);
  });

  it("attaches an artifact of exactly the bound -- the limit is inclusive", async () => {
    const { sender, sendMail } = build();
    const body = Buffer.alloc(2 * MIB, 1);

    const result = await sender.send(input({ body, maxBytes: 2 * MIB }));

    expect(result).toEqual({ outcome: "uploaded" });
    expect(sendMail.mock.calls[0][3]?.attachments).toHaveLength(1);
  });

  it("sends a notice with no bytes when the artifact is over the bound", async () => {
    // Spec section 8, example 6: over the bound is `skipped-too-large`, never
    // a link and never a truncated attachment.
    const { sender, sendMail } = build();
    const body = Buffer.alloc(3 * MIB, 2);

    const result = await sender.send(input({ body, maxBytes: 1 * MIB }));

    expect(result).toEqual({ outcome: "skipped-too-large" });
    const [, subject, html, options] = sendMail.mock.calls[0];
    expect(subject).toContain("too large");
    expect(html).toContain("Nothing was attached to this email");
    expect(options).toBeUndefined();
  });

  it("refuses a plaintext artifact and sends nothing (INV-BACKUP-002)", async () => {
    // The artifact carries third-party API keys in the clear inside it, so a
    // refusal that only the dispatcher held would be one path deep.
    const { sender, sendMail } = build();

    await expect(
      sender.send(
        input({ filename: "monize-backup-daily-2026-09-14.json.gz" }),
      ),
    ).rejects.toThrow("only an encrypted .mzbe artifact");
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("refuses a body that is not the size that was bounded", async () => {
    const { sender, sendMail } = build();

    await expect(
      sender.send(input({ body: Buffer.alloc(16), sizeBytes: 5 * MIB })),
    ).rejects.toThrow("not the 5242880 bytes that were measured");
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("propagates an SMTP failure without reporting uploaded (EXT-002)", async () => {
    const { sender, sendMail } = build();
    const cause = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNECTION",
    });
    sendMail.mockRejectedValueOnce(cause);

    await expect(sender.send(input())).rejects.toBe(cause);
  });

  it("propagates an SMTP failure on the notice path too", async () => {
    const { sender, sendMail } = build();
    sendMail.mockRejectedValueOnce(new Error("550 mailbox full"));

    await expect(
      sender.send(input({ body: Buffer.alloc(8), sizeBytes: 8, maxBytes: 4 })),
    ).rejects.toThrow("550 mailbox full");
  });

  it("renders in the recipient's stored locale, not a request's", async () => {
    const { sender, sendMail, translate } = build();

    await sender.send(input({ recipientLang: "fr", body: Buffer.alloc(32) }));

    expect(translate).toHaveBeenCalledWith(
      "emails.backupOffsite.copyHeading",
      expect.objectContaining({ lang: "fr" }),
    );
    expect(sendMail).toHaveBeenCalled();
  });

  it("labels a monthly artifact by its month", async () => {
    const { sender, sendMail } = build();

    await sender.send(
      input({
        filename: "monize-backup-monthly-26-09.mzbe",
        tier: "monthly",
        body: Buffer.alloc(64),
      }),
    );

    expect(sendMail.mock.calls[0][2]).toContain("2026-09");
  });
});
