import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { EmailService, resolveSmtpTransportSecurity } from "./email.service";

// Mock nodemailer before importing EmailService
jest.mock("nodemailer", () => ({
  createTransport: jest.fn().mockReturnValue({
    sendMail: jest.fn().mockResolvedValue({ messageId: "mock-id" }),
    verify: jest.fn().mockResolvedValue(true),
  }),
}));

import * as nodemailer from "nodemailer";

describe("EmailService", () => {
  let service: EmailService;
  let configService: Record<string, jest.Mock>;

  describe("when SMTP is configured", () => {
    beforeEach(async () => {
      configService = {
        get: jest.fn().mockImplementation((key: string, defaultVal?: any) => {
          const config: Record<string, any> = {
            SMTP_HOST: "smtp.example.com",
            SMTP_USER: "user@example.com",
            SMTP_PASSWORD: "password123",
            SMTP_PORT: "587",
            EMAIL_FROM: "noreply@monize.app",
          };
          return config[key] ?? defaultVal;
        }),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          EmailService,
          { provide: ConfigService, useValue: configService },
        ],
      }).compile();

      service = module.get<EmailService>(EmailService);
      service.onModuleInit();
    });

    it("configures transport with STARTTLS on port 587", () => {
      expect(nodemailer.createTransport).toHaveBeenCalledWith(
        expect.objectContaining({
          host: "smtp.example.com",
          port: 587,
          secure: false,
          requireTLS: true,
          auth: { user: "user@example.com", pass: "password123" },
        }),
      );
    });

    it("reports configured status", () => {
      expect(service.getStatus()).toEqual({ configured: true });
    });

    it("sends email successfully", async () => {
      await service.sendMail("to@example.com", "Subject", "<p>Body</p>");

      const transporter = (nodemailer.createTransport as jest.Mock).mock
        .results[0].value;
      expect(transporter.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "to@example.com",
          subject: "Subject",
          html: "<p>Body</p>",
        }),
      );
    });

    it("hands attachments to the transporter", async () => {
      // The off-site backup destination is the one caller that sends bytes:
      // the encrypted artifact IS the mail (docs/specs/backup-off-machine.md).
      const content = Buffer.from("MZBE encrypted artifact");
      await service.sendMail("to@example.com", "Subject", "<p>Body</p>", {
        attachments: [
          {
            filename: "monize-backup-daily-2026-09-14.mzbe",
            content,
            contentType: "application/octet-stream",
          },
        ],
      });

      const transporter = (nodemailer.createTransport as jest.Mock).mock
        .results[0].value;
      expect(transporter.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "to@example.com",
          attachments: [
            {
              filename: "monize-backup-daily-2026-09-14.mzbe",
              content,
              contentType: "application/octet-stream",
            },
          ],
        }),
      );
    });

    it("sends no attachments key when none were supplied", async () => {
      // Every existing caller is three-argument, and nodemailer treats an
      // `attachments` key as part of the message: an empty one must not appear.
      const sent = (nodemailer.createTransport as jest.Mock).mock.results[0]
        .value.sendMail as jest.Mock;
      sent.mockClear();

      await service.sendMail("to@example.com", "Subject", "<p>Body</p>");
      await service.sendMail("to@example.com", "Subject", "<p>Body</p>", {});
      await service.sendMail("to@example.com", "Subject", "<p>Body</p>", {
        attachments: [],
      });

      expect(sent).toHaveBeenCalledTimes(3);
      for (const call of sent.mock.calls) {
        expect(call[0]).not.toHaveProperty("attachments");
      }
    });

    it("verifies connection successfully", async () => {
      const result = await service.verifyConnection();
      expect(result).toBe(true);
    });

    describe("failure snapshot (read by the SMTP-health sweep)", () => {
      it("starts empty", () => {
        expect(service.getFailureSnapshot()).toEqual({
          lastFailureAt: null,
          lastFailureMessage: null,
          lastSuccessAt: null,
          failuresSinceSuccess: 0,
          recipientRejections: 0,
        });
      });

      it("records a transport failure, bounded, and rethrows unchanged", async () => {
        const transporter = (nodemailer.createTransport as jest.Mock).mock
          .results[0].value;
        const cause = new Error("ECONNREFUSED " + "x".repeat(400));
        transporter.sendMail.mockRejectedValueOnce(cause);

        await expect(service.sendMail("to@example.com", "S", "B")).rejects.toBe(
          cause,
        );

        const snapshot = service.getFailureSnapshot();
        expect(snapshot.lastFailureAt).toBeInstanceOf(Date);
        expect(snapshot.lastFailureMessage).toHaveLength(300);
        expect(snapshot.failuresSinceSuccess).toBe(1);
        expect(snapshot.lastSuccessAt).toBeNull();
      });

      it("counts consecutive failures and resets on success", async () => {
        const transporter = (nodemailer.createTransport as jest.Mock).mock
          .results[0].value;
        transporter.sendMail
          .mockRejectedValueOnce(new Error("greylisted"))
          .mockRejectedValueOnce(new Error("greylisted"));

        await expect(service.sendMail("a@e.f", "S", "B")).rejects.toThrow();
        await expect(service.sendMail("a@e.f", "S", "B")).rejects.toThrow();
        expect(service.getFailureSnapshot().failuresSinceSuccess).toBe(2);

        await service.sendMail("a@e.f", "S", "B");
        const snapshot = service.getFailureSnapshot();
        expect(snapshot.failuresSinceSuccess).toBe(0);
        expect(snapshot.lastSuccessAt).toBeInstanceOf(Date);
        // The failure history stays readable: the sweep compares the two
        // timestamps rather than needing the failure erased.
        expect(snapshot.lastFailureAt).toBeInstanceOf(Date);
      });

      it("does not count a per-recipient rejection as a transport failure", async () => {
        // A `550 mailbox full` means the relay ANSWERED and refused this
        // address. Counted as an outage it told every administrator that
        // "email delivery is failing" every fifteen minutes for a day, on an
        // outbox that was working for everybody else.
        const transporter = (nodemailer.createTransport as jest.Mock).mock
          .results[0].value;
        transporter.sendMail.mockRejectedValueOnce(
          Object.assign(new Error("550 5.2.2 Mailbox full"), {
            responseCode: 550,
            code: "EENVELOPE",
          }),
        );

        await expect(service.sendMail("full@e.f", "S", "B")).rejects.toThrow();

        const snapshot = service.getFailureSnapshot();
        expect(snapshot.recipientRejections).toBe(1);
        expect(snapshot.lastFailureAt).toBeNull();
        expect(snapshot.failuresSinceSuccess).toBe(0);
      });

      it("counts an authentication failure as transport -- nothing will ever be delivered", async () => {
        const transporter = (nodemailer.createTransport as jest.Mock).mock
          .results[0].value;
        transporter.sendMail.mockRejectedValueOnce(
          Object.assign(new Error("Invalid login"), {
            code: "EAUTH",
            responseCode: 535,
          }),
        );
        await expect(service.sendMail("a@e.f", "S", "B")).rejects.toThrow();
        expect(service.getFailureSnapshot().failuresSinceSuccess).toBe(1);
      });

      it("counts an error carrying no SMTP response as transport", async () => {
        const transporter = (nodemailer.createTransport as jest.Mock).mock
          .results[0].value;
        transporter.sendMail.mockRejectedValueOnce(
          Object.assign(new Error("connect ECONNREFUSED"), {
            code: "ECONNECTION",
          }),
        );
        await expect(service.sendMail("a@e.f", "S", "B")).rejects.toThrow();
        expect(service.getFailureSnapshot().failuresSinceSuccess).toBe(1);
      });

      it("does not count the unconfigured throw -- that is a setup state, not a transport failure", async () => {
        const unconfigured = new EmailService({
          get: jest.fn().mockReturnValue(undefined),
        } as never);
        unconfigured.onModuleInit();
        await expect(
          unconfigured.sendMail("to@example.com", "S", "B"),
        ).rejects.toThrow("SMTP is not configured");
        expect(unconfigured.getFailureSnapshot().failuresSinceSuccess).toBe(0);
      });
    });

    it("returns false when verify throws", async () => {
      const transporter = (nodemailer.createTransport as jest.Mock).mock
        .results[0].value;
      transporter.verify.mockRejectedValueOnce(new Error("Connection failed"));

      const result = await service.verifyConnection();
      expect(result).toBe(false);
    });
  });

  // `SMTP_PORT` arrives as the string "465", the way ConfigService returns it.
  // A mock that supplied the number hid the defect this suite now covers.
  describe("when SMTP is configured with port 465", () => {
    beforeEach(async () => {
      (nodemailer.createTransport as jest.Mock).mockClear();
      configService = {
        get: jest.fn().mockImplementation((key: string, defaultVal?: any) => {
          const config: Record<string, any> = {
            SMTP_HOST: "smtp.example.com",
            SMTP_USER: "user@example.com",
            SMTP_PASSWORD: "password123",
            SMTP_PORT: "465",
            EMAIL_FROM: "noreply@monize.app",
          };
          return config[key] ?? defaultVal;
        }),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          EmailService,
          { provide: ConfigService, useValue: configService },
        ],
      }).compile();

      service = module.get<EmailService>(EmailService);
      service.onModuleInit();
    });

    it("configures transport with implicit TLS on port 465", () => {
      expect(nodemailer.createTransport).toHaveBeenCalledWith(
        expect.objectContaining({
          host: "smtp.example.com",
          port: 465,
          secure: true,
          auth: { user: "user@example.com", pass: "password123" },
        }),
      );
      expect(nodemailer.createTransport).not.toHaveBeenCalledWith(
        expect.objectContaining({ requireTLS: true }),
      );
    });
  });

  describe("when SMTP is not configured", () => {
    beforeEach(async () => {
      configService = {
        get: jest.fn().mockReturnValue(undefined),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          EmailService,
          { provide: ConfigService, useValue: configService },
        ],
      }).compile();

      service = module.get<EmailService>(EmailService);
      service.onModuleInit();
    });

    it("reports not configured status", () => {
      expect(service.getStatus()).toEqual({ configured: false });
    });

    it("throws when trying to send email", async () => {
      await expect(
        service.sendMail("to@example.com", "Subject", "Body"),
      ).rejects.toThrow("SMTP is not configured");
    });

    it("returns false for verifyConnection", async () => {
      const result = await service.verifyConnection();
      expect(result).toBe(false);
    });
  });

  /**
   * Regression: `SMTP_PORT` is a string in every deployment, so the former
   * `port === 465` never matched and port 465 opened in cleartext. Gmail's
   * implicit-TLS port answers that by closing the socket, which nodemailer
   * surfaces as `Error: Unexpected socket close`.
   */
  describe("resolveSmtpTransportSecurity", () => {
    it("selects implicit TLS for the string port 465", () => {
      expect(resolveSmtpTransportSecurity("465", undefined)).toEqual({
        port: 465,
        secure: true,
        portInvalid: false,
      });
    });

    it("selects STARTTLS for the string port 587", () => {
      expect(resolveSmtpTransportSecurity("587", undefined)).toEqual({
        port: 587,
        secure: false,
        portInvalid: false,
      });
    });

    it("accepts a numeric port too", () => {
      expect(resolveSmtpTransportSecurity(465, undefined).secure).toBe(true);
    });

    it("defaults an unset or empty port without calling it invalid", () => {
      for (const raw of [undefined, null, "", "   "]) {
        expect(resolveSmtpTransportSecurity(raw, undefined)).toEqual({
          port: 587,
          secure: false,
          portInvalid: false,
        });
      }
    });

    it("reports a port that is not a usable TCP port", () => {
      for (const raw of ["ten", "58.7", "-1", "0", "70000"]) {
        expect(resolveSmtpTransportSecurity(raw, undefined)).toEqual({
          port: 587,
          secure: false,
          portInvalid: true,
        });
      }
    });

    it("lets SMTP_SECURE turn implicit TLS on for a non-standard port", () => {
      expect(resolveSmtpTransportSecurity("2465", "true").secure).toBe(true);
      expect(resolveSmtpTransportSecurity("2465", "TRUE ").secure).toBe(true);
      expect(resolveSmtpTransportSecurity("2465", true).secure).toBe(true);
      expect(resolveSmtpTransportSecurity("2465", undefined).secure).toBe(
        false,
      );
    });

    it("never lets SMTP_SECURE turn implicit TLS off on port 465", () => {
      // The Helm chart ships the string "false" as its default; port 465 has
      // no cleartext phase, so honouring that literally would break the send.
      expect(resolveSmtpTransportSecurity("465", "false").secure).toBe(true);
    });
  });
});
