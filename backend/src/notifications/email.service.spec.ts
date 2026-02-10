import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { EmailService } from "./email.service";

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
            SMTP_SECURE: "false",
            SMTP_PORT: 587,
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

    it("configures transport on init", () => {
      expect(nodemailer.createTransport).toHaveBeenCalledWith(
        expect.objectContaining({
          host: "smtp.example.com",
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

    it("verifies connection successfully", async () => {
      const result = await service.verifyConnection();
      expect(result).toBe(true);
    });

    it("returns false when verify throws", async () => {
      const transporter = (nodemailer.createTransport as jest.Mock).mock
        .results[0].value;
      transporter.verify.mockRejectedValueOnce(new Error("Connection failed"));

      const result = await service.verifyConnection();
      expect(result).toBe(false);
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
});
