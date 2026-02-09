import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { EmailService } from "./email.service";
import { BillReminderService } from "./bill-reminder.service";
import { NotificationsController } from "./notifications.controller";
import { UsersModule } from "../users/users.module";
import { ScheduledTransaction } from "../scheduled-transactions/entities/scheduled-transaction.entity";
import { User } from "../users/entities/user.entity";
import { UserPreference } from "../users/entities/user-preference.entity";

@Module({
  imports: [
    TypeOrmModule.forFeature([ScheduledTransaction, User, UserPreference]),
    UsersModule,
  ],
  providers: [EmailService, BillReminderService],
  controllers: [NotificationsController],
  exports: [EmailService],
})
export class NotificationsModule {}
