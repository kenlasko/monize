import {
  Controller,
  Get,
  Post,
  UseGuards,
  Request,
  BadRequestException,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { I18nService } from "nestjs-i18n";
import { tr } from "../i18n/translate";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import { EmailService } from "./email.service";
import { UsersService } from "../users/users.service";
import { UserPreference } from "../users/entities/user-preference.entity";
import { testEmailTemplate } from "./email-templates";
import { emailTranslator } from "../i18n/email-translator";
import { resolveUserEmailLocale } from "../i18n/resolve-user-email-locale";

@ApiTags("Notifications")
@Controller("notifications")
@UseGuards(AuthGuard("jwt"))
@ApiBearerAuth()
export class NotificationsController {
  constructor(
    private readonly emailService: EmailService,
    private readonly usersService: UsersService,
    private readonly i18n: I18nService,
    @InjectRepository(UserPreference)
    private readonly preferencesRepository: Repository<UserPreference>,
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
        tr(
          "errors.notifications.smtpNotConfigured",
          "SMTP is not configured. Set SMTP environment variables.",
        ),
      );
    }

    const user = await this.usersService.findById(req.user.id);
    if (!user || !user.email) {
      throw new BadRequestException(
        tr(
          "errors.notifications.noEmailOnFile",
          "No email address on file for this user.",
        ),
      );
    }

    const lang = await resolveUserEmailLocale(
      this.preferencesRepository,
      user.id,
    );
    const t = emailTranslator(this.i18n, lang);
    const html = testEmailTemplate(user.firstName || "", t);
    const subject = t("emails.test.subject", "Monize Test Email");
    await this.emailService.sendMail(user.email, subject, html);
    return { message: "Test email sent successfully" };
  }
}
