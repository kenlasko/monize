import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { NotificationsController } from "./notifications.controller";
import { EmailService } from "./email.service";
import { UsersService } from "../users/users.service";

describe("NotificationsController", () => {
  let controller: NotificationsController;
  let mockEmailService: Partial<Record<keyof EmailService, jest.Mock>>;
  let mockUsersService: Partial<Record<keyof UsersService, jest.Mock>>;
  const mockReq = { user: { id: "user-1" } };

  beforeEach(async () => {
    mockEmailService = {
      getStatus: jest.fn(),
      sendMail: jest.fn(),
    };

    mockUsersService = {
      findById: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [NotificationsController],
      providers: [
        {
          provide: EmailService,
          useValue: mockEmailService,
        },
        {
          provide: UsersService,
          useValue: mockUsersService,
        },
      ],
    }).compile();

    controller = module.get<NotificationsController>(NotificationsController);
  });

  describe("getSmtpStatus()", () => {
    it("delegates to emailService.getStatus", () => {
      const status = { configured: true, host: "smtp.example.com" };
      mockEmailService.getStatus!.mockReturnValue(status);

      const result = controller.getSmtpStatus();

      expect(result).toEqual(status);
      expect(mockEmailService.getStatus).toHaveBeenCalledWith();
    });
  });

  describe("sendTestEmail()", () => {
    it("sends test email when SMTP is configured and user has email", async () => {
      mockEmailService.getStatus!.mockReturnValue({ configured: true });
      mockUsersService.findById!.mockResolvedValue({
        email: "test@example.com",
        firstName: "John",
      });
      mockEmailService.sendMail!.mockResolvedValue(undefined);

      const result = await controller.sendTestEmail(mockReq);

      expect(result).toEqual({ message: "Test email sent successfully" });
      expect(mockUsersService.findById).toHaveBeenCalledWith("user-1");
      expect(mockEmailService.sendMail).toHaveBeenCalledWith(
        "test@example.com",
        "Monize Test Email",
        expect.any(String),
      );
    });

    it("throws BadRequestException when SMTP is not configured", async () => {
      mockEmailService.getStatus!.mockReturnValue({ configured: false });

      await expect(controller.sendTestEmail(mockReq)).rejects.toThrow(
        BadRequestException,
      );
      await expect(controller.sendTestEmail(mockReq)).rejects.toThrow(
        "SMTP is not configured. Set SMTP environment variables.",
      );
      expect(mockUsersService.findById).not.toHaveBeenCalled();
    });

    it("throws BadRequestException when user has no email", async () => {
      mockEmailService.getStatus!.mockReturnValue({ configured: true });
      mockUsersService.findById!.mockResolvedValue({
        email: null,
        firstName: "John",
      });

      await expect(controller.sendTestEmail(mockReq)).rejects.toThrow(
        BadRequestException,
      );
      await expect(controller.sendTestEmail(mockReq)).rejects.toThrow(
        "No email address on file for this user.",
      );
    });

    it("throws BadRequestException when user is not found", async () => {
      mockEmailService.getStatus!.mockReturnValue({ configured: true });
      mockUsersService.findById!.mockResolvedValue(null);

      await expect(controller.sendTestEmail(mockReq)).rejects.toThrow(
        BadRequestException,
      );
      await expect(controller.sendTestEmail(mockReq)).rejects.toThrow(
        "No email address on file for this user.",
      );
    });
  });
});
