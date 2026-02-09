import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as nodemailer from "nodemailer";
import { Transporter } from "nodemailer";

@Injectable()
export class EmailService implements OnModuleInit {
  private readonly logger = new Logger(EmailService.name);
  private transporter: Transporter | null = null;
  private configured = false;

  constructor(private configService: ConfigService) {}

  onModuleInit() {
    const host = this.configService.get<string>("SMTP_HOST");
    const user = this.configService.get<string>("SMTP_USER");
    const password = this.configService.get<string>("SMTP_PASSWORD");

    if (!host || !user || !password) {
      this.logger.warn("SMTP not configured - email features disabled");
      return;
    }

    const secure =
      this.configService.get<string>("SMTP_SECURE", "false") === "true";
    const port = this.configService.get<number>(
      "SMTP_PORT",
      secure ? 465 : 587,
    );

    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user, pass: password },
    });

    this.configured = true;
    this.logger.log("SMTP email transport configured");
  }

  getStatus(): { configured: boolean } {
    return { configured: this.configured };
  }

  async sendMail(to: string, subject: string, html: string): Promise<void> {
    if (!this.transporter || !this.configured) {
      throw new Error("SMTP is not configured");
    }

    const from = this.configService.get<string>(
      "EMAIL_FROM",
      "noreply@monize.app",
    );
    await this.transporter.sendMail({ from, to, subject, html });
    this.logger.log(`Email sent to ${to}: ${subject}`);
  }

  async verifyConnection(): Promise<boolean> {
    if (!this.transporter) return false;
    try {
      await this.transporter.verify();
      return true;
    } catch {
      return false;
    }
  }
}
