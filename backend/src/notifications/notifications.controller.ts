import {
  Controller,
  Get,
  Post,
  UseGuards,
  Request,
  BadRequestException,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import { EmailService } from "./email.service";
import { UsersService } from "../users/users.service";
import { testEmailTemplate } from "./email-templates";

@ApiTags("Notifications")
@Controller("notifications")
@UseGuards(AuthGuard("jwt"))
@ApiBearerAuth()
export class NotificationsController {
  constructor(
    private readonly emailService: EmailService,
    private readonly usersService: UsersService,
  ) {}

  @Get("smtp-status")
  @ApiOperation({ summary: "Check if SMTP is configured" })
  getSmtpStatus() {
    return this.emailService.getStatus();
  }

  @Post("test-email")
  @ApiOperation({ summary: "Send a test email to the current user" })
  async sendTestEmail(@Request() req) {
    const status = this.emailService.getStatus();
    if (!status.configured) {
      throw new BadRequestException(
        "SMTP is not configured. Set SMTP environment variables.",
      );
    }

    const user = await this.usersService.findById(req.user.id);
    if (!user || !user.email) {
      throw new BadRequestException("No email address on file for this user.");
    }

    const html = testEmailTemplate(user.firstName || "");
    await this.emailService.sendMail(user.email, "MoneyMate Test Email", html);
    return { message: "Test email sent successfully" };
  }
}
